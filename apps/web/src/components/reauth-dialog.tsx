import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldGroup,
  FieldSeparator,
} from '@nestjs-monorepo-template/ui/components/field';
import { KeyRoundIcon, MailIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useCaptcha } from '@/components/auth/captcha';
import { providerName } from '@/components/login-form';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  getPasskeyAssertion,
  isPasskeyCancelled,
  passkeysSupported,
} from '@/lib/passkeys';
import {
  settleReauthentication,
  useReauthRequest,
  type ReauthProblem,
} from '@/lib/reauth';
import { meQuery } from '@/lib/session';

/**
 * Step-up (docs/auth.md, "Step-up"): a sensitive route answered 403
 * `reauthentication_required`; the user confirms it's them with what the
 * problem's `methods` allow, and lib/api.ts sends the request again.
 * `password`, `totp` and `passkey` re-authenticate here; `magic-link` and
 * `oidc:<provider>` by signing in again (the new session is recent).
 */
export function ReauthDialog() {
  const problem = useReauthRequest();
  const { t } = useTranslation();
  return (
    <Dialog
      open={problem !== null}
      onOpenChange={(open) => {
        if (!open) {
          settleReauthentication(false);
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('auth.reauth.title')}</DialogTitle>
          <DialogDescription>{t('auth.reauth.description')}</DialogDescription>
        </DialogHeader>
        {problem && <ReauthMethods problem={problem} />}
      </DialogContent>
    </Dialog>
  );
}

function ReauthMethods({ problem }: { problem: ReauthProblem }) {
  const { t } = useTranslation();
  const methods = problem.methods ?? ['password'];
  const providers = methods
    .filter((method) => method.startsWith('oidc:'))
    .map((method) => method.slice('oidc:'.length));
  const inPlace = methods.includes('password') || methods.includes('totp');
  const passkey = methods.includes('passkey') && passkeysSupported();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const withPasskey = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const options = await unwrap(
        api.POST('/v1/auth/passkeys/reauthentication/options'),
      );
      const assertion = await getPasskeyAssertion(options);
      await unwrap(
        api.POST('/v1/auth/reauthenticate', { body: { passkey: assertion } }),
      );
      settleReauthentication(true);
    } catch (caught) {
      if (!isPasskeyCancelled(caught)) {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const here = `${location.pathname}${location.search}`;
  return (
    <FieldGroup>
      <FormAlert message={error} />
      {inPlace && (
        <PasswordReauth
          password={methods.includes('password')}
          code={problem.mfaRequired === true || !methods.includes('password')}
        />
      )}
      {(passkey || providers.length > 0 || methods.includes('magic-link')) &&
        inPlace && <FieldSeparator>{t('auth.reauth.or')}</FieldSeparator>}
      <Field>
        {passkey && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void withPasskey()}
          >
            <KeyRoundIcon />
            {t('auth.reauth.withPasskey')}
          </Button>
        )}
        {providers.map((provider) => (
          <Button
            key={provider}
            variant="outline"
            nativeButton={false}
            render={
              <a
                href={`/v1/auth/oidc/${encodeURIComponent(provider)}/login?reauthenticate=true&redirectTo=${encodeURIComponent(here)}`}
              />
            }
          >
            {t('auth.signIn.withProvider', {
              provider: providerName(provider),
            })}
          </Button>
        ))}
        {methods.includes('magic-link') && <MagicLinkReauth redirect={here} />}
      </Field>
    </FieldGroup>
  );
}

/** The password (and a code with two-factor on), or a code alone. */
function PasswordReauth(props: { password: boolean; code: boolean }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { password: '', code: '' },
    validators: {
      onSubmit: z.object({
        password: props.password
          ? z.string().min(1, t('auth.fields.passwordRequired'))
          : z.string(),
        code: props.code
          ? z.string().trim().min(1, t('auth.reauth.codeRequired'))
          : z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const code = value.code.trim();
      try {
        await unwrap(
          api.POST('/v1/auth/reauthenticate', {
            body: {
              ...(props.password && { password: value.password }),
              // Six digits: the authenticator's; anything else: a recovery code.
              ...(props.code &&
                (/^\d{6}$/.test(code) ? { code } : { recoveryCode: code })),
            },
          }),
        );
        settleReauthentication(true);
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <FormAlert message={error} />
        {props.password && (
          <form.AppField name="password">
            {(field) => (
              <field.TextField
                label={t('auth.fields.password')}
                type="password"
                autoComplete="current-password"
                autoFocus
              />
            )}
          </form.AppField>
        )}
        {props.code && (
          <form.AppField name="code">
            {(field) => (
              <field.TextField
                label={t('auth.reauth.code')}
                autoComplete="one-time-code"
                description={t('auth.reauth.codeHint')}
              />
            )}
          </form.AppField>
        )}
        <form.AppForm>
          <form.SubmitButton>{t('auth.reauth.confirm')}</form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}

/** Signing in again by email link: the link's session is a recent one. */
function MagicLinkReauth(props: { redirect: string }) {
  const { t } = useTranslation();
  const email = useQuery(meQuery).data?.user.email;
  const captcha = useCaptcha('magic-link');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  if (!email) {
    return null;
  }
  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('auth.magicLink.sent')}
      </p>
    );
  }
  return (
    <>
      <FormAlert message={error} />
      {captcha.element}
      <Button
        type="button"
        variant="outline"
        disabled={!captcha.ready}
        onClick={async () => {
          setError(undefined);
          try {
            await unwrap(
              api.POST('/v1/auth/magic-link', {
                params: { header: captcha.header() },
                body: { email, redirectTo: props.redirect },
              }),
            );
            captcha.settle();
            setSent(true);
          } catch (caught) {
            if (!captcha.settle(caught)) {
              setError(errorMessage(caught));
            }
          }
        }}
      >
        <MailIcon />
        {t('auth.reauth.withMagicLink')}
      </Button>
    </>
  );
}
