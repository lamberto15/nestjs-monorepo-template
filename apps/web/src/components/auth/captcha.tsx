import { Turnstile } from '@marsidev/react-turnstile';
import { useQuery } from '@tanstack/react-query';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { useTheme } from '@nestjs-monorepo-template/ui/components/theme-provider';
import { useState } from 'react';
import { methodsQuery } from '@/lib/session';

/** The routes' actions (`data-action`), as the API checks them. */
export type CaptchaAction =
  | 'sign-in'
  | 'sign-up'
  | 'magic-link'
  | 'forgot-password'
  | 'resend-verification'
  | 'public-form';

type Challenge = { provider: string; siteKey: string | null };

/**
 * Bot protection (docs/auth.md, "Bot protection"): with `methods.captcha`
 * set, the form renders the Turnstile widget (always, or once a 403
 * `captcha_required` / `captcha_invalid` asks) and sends its token in
 * `X-Captcha-Token`. A token is good once: the widget is reset after every
 * attempt (remounted). @marsidev/react-turnstile loads Cloudflare's script and renders
 * the widget (the documented React integration).
 */
export function useCaptcha(action: CaptchaAction) {
  const { data: methods } = useQuery(methodsQuery);
  const [asked, setAsked] = useState<Challenge | null>(null);
  const [token, setToken] = useState<string>();
  // A new widget for each attempt (a token is good once).
  const [attempt, setAttempt] = useState(0);
  const config = methods?.captcha ?? null;
  const challenge: Challenge | null =
    asked ?? (config?.mode === 'always' ? config : null);
  // The API's stand-in for load tests (refused in production) has no widget:
  // in development it passes with a fresh `stub:pass:` token.
  const stub = challenge?.provider === 'stub' && import.meta.env.DEV;

  return {
    /** Whether the form may be sent (the widget solved, when shown). */
    ready: !challenge || stub || !!token,
    /** The request's headers: `params: { header: captcha.header() }`. */
    header(): { 'X-Captcha-Token'?: string } {
      if (stub) {
        return { 'X-Captcha-Token': `stub:pass:${crypto.randomUUID()}` };
      }
      return token ? { 'X-Captcha-Token': token } : {};
    },
    /**
     * After an attempt: the token is spent. Returns true when the error was
     * the challenge asking (the widget is shown, the user tries again).
     */
    settle(error?: unknown): boolean {
      setToken(undefined);
      setAttempt((value) => value + 1);
      if (
        isApiError(error) &&
        (error.code === 'captcha_required' || error.code === 'captcha_invalid')
      ) {
        const problem = error.problem;
        setAsked({
          provider:
            typeof problem.provider === 'string'
              ? problem.provider
              : (config?.provider ?? 'turnstile'),
          siteKey:
            typeof problem.siteKey === 'string'
              ? problem.siteKey
              : (config?.siteKey ?? null),
        });
        return true;
      }
      return false;
    },
    element:
      challenge && !stub && challenge.siteKey ? (
        <CaptchaWidget
          key={attempt}
          siteKey={challenge.siteKey}
          action={action}
          onToken={setToken}
        />
      ) : null,
  };
}

function CaptchaWidget(props: {
  siteKey: string;
  action: CaptchaAction;
  onToken: (token: string | undefined) => void;
}) {
  const { theme } = useTheme();
  return (
    <Turnstile
      siteKey={props.siteKey}
      options={{
        action: props.action,
        theme: theme === 'system' ? 'auto' : theme,
        size: 'flexible',
      }}
      onSuccess={props.onToken}
      onExpire={() => props.onToken(undefined)}
      onError={() => props.onToken(undefined)}
    />
  );
}
