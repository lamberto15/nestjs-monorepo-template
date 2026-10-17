import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldSeparator,
} from '@nestjs-monorepo-template/ui/components/field';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { KeyRoundIcon, MailIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from '@/lib/zod';
import { useCaptcha } from '@/components/auth/captcha';
import { MfaStep } from '@/components/auth/mfa-step';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import {
  getPasskeyAssertion,
  isPasskeyCancelled,
  passkeysSupported,
} from '@/lib/passkeys';
import { methodsQuery } from '@/lib/session';
import { useFinishSignIn, type SignInResult } from '@/lib/sign-in';
import { safeRedirect } from '@/lib/safe-redirect';

type Step = 'credentials' | 'magic-link' | 'magic-link-sent' | 'mfa';

/**
 * The sign-in form, from shadcn's login-03 block, driven by
 * `GET /v1/auth/methods`: password, an email link, a passkey, the providers,
 * the bot check; then the second factor when the account has it.
 */
export function LoginForm(props: { redirect?: string }) {
  const { t } = useTranslation();
  const methods = useQuery(methodsQuery);
  const [step, setStep] = useState<Step>('credentials');
  const finish = useFinishSignIn();

  const signedIn = async (result: SignInResult) => {
    if (result.mfaRequired) {
      setStep('mfa');
      return;
    }
    await finish(props.redirect, result);
  };

  if (methods.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (methods.isError) {
    return <FormAlert message={errorMessage(methods.error)} />;
  }

  if (step === 'mfa') {
    return (
      <MfaStep onSignedIn={signedIn} onRestart={() => setStep('credentials')} />
    );
  }
  if (step === 'magic-link-sent') {
    return (
      <Alert>
        <MailIcon />
        <AlertDescription>{t('auth.magicLink.sent')}</AlertDescription>
      </Alert>
    );
  }
  if (step === 'magic-link') {
    return (
      <MagicLinkRequest
        redirect={props.redirect}
        onSent={() => setStep('magic-link-sent')}
        onBack={() => setStep('credentials')}
      />
    );
  }
  return (
    <PasswordSignIn
      redirect={props.redirect}
      onSignedIn={signedIn}
      onMagicLink={() => setStep('magic-link')}
    />
  );
}

function PasswordSignIn(props: {
  redirect?: string;
  onSignedIn: (result: SignInResult) => Promise<void>;
  onMagicLink: () => void;
}) {
  const { t } = useTranslation();
  const { data: methods } = useQuery(methodsQuery);
  const [error, setError] = useState<string>();
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const captcha = useCaptcha('sign-in');
  const form = useAppForm({
    defaultValues: { email: '', password: '' },
    validators: {
      onSubmit: z.object({
        email: z.email(t('auth.fields.emailInvalid')),
        password: z.string().min(1, t('auth.fields.passwordRequired')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const result = await unwrap(
          api.POST('/v1/auth/sign-in', {
            params: { header: captcha.header() },
            body: value,
          }),
        );
        captcha.settle();
        await props.onSignedIn(result);
      } catch (caught) {
        if (captcha.settle(caught) || applyFieldErrors(form, caught)) {
          return;
        }
        setError(errorMessage(caught));
      }
    },
  });

  const signInWithPasskey = async () => {
    setError(undefined);
    setPasskeyBusy(true);
    try {
      // With an address typed, the account's passkeys are offered; without,
      // the browser offers this site's discoverable ones.
      const email = z.email().safeParse(form.state.values.email);
      const options = await unwrap(
        api.POST('/v1/auth/passkeys/sign-in/options', {
          body: email.success ? { email: email.data } : {},
        }),
      );
      const response = await getPasskeyAssertion(options);
      const result = await unwrap(
        api.POST('/v1/auth/passkeys/sign-in', {
          params: { header: captcha.header() },
          body: { response },
        }),
      );
      captcha.settle();
      await props.onSignedIn(result);
    } catch (caught) {
      if (isPasskeyCancelled(caught) || captcha.settle(caught)) {
        return;
      }
      setError(errorMessage(caught));
    } finally {
      setPasskeyBusy(false);
    }
  };

  if (!methods) {
    return null;
  }
  const target = safeRedirect(props.redirect);
  const alternatives =
    methods.providers.length > 0 ||
    (methods.passkeys && passkeysSupported()) ||
    methods.magicLink;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        {alternatives && (
          <>
            <Field>
              {methods.providers.map((provider) => (
                <Button
                  key={provider}
                  variant="outline"
                  nativeButton={false}
                  render={
                    // A full navigation: the API redirects to the provider.
                    <a
                      href={`/v1/auth/oidc/${encodeURIComponent(provider)}/login?redirectTo=${encodeURIComponent(target)}`}
                    />
                  }
                >
                  {t('auth.signIn.withProvider', {
                    provider: providerName(provider),
                  })}
                </Button>
              ))}
              {methods.passkeys && passkeysSupported() && (
                <Button
                  variant="outline"
                  type="button"
                  disabled={passkeyBusy || !captcha.ready}
                  onClick={() => void signInWithPasskey()}
                >
                  <KeyRoundIcon />
                  {t('auth.signIn.withPasskey')}
                </Button>
              )}
              {methods.magicLink && (
                <Button
                  variant="outline"
                  type="button"
                  onClick={props.onMagicLink}
                >
                  <MailIcon />
                  {t('auth.signIn.withMagicLink')}
                </Button>
              )}
            </Field>
            <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
              {t('auth.signIn.orContinueWith')}
            </FieldSeparator>
          </>
        )}
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => (
            <field.TextField
              label={t('auth.fields.email')}
              type="email"
              autoComplete="username webauthn"
              placeholder="m@example.com"
            />
          )}
        </form.AppField>
        <form.AppField name="password">
          {(field) => (
            <field.TextField
              label={t('auth.fields.password')}
              type="password"
              autoComplete="current-password"
              aside={
                <Link
                  to="/forgot-password"
                  className="underline-offset-4 hover:underline"
                >
                  {t('auth.signIn.forgot')}
                </Link>
              }
            />
          )}
        </form.AppField>
        {captcha.element}
        <Field>
          <form.AppForm>
            <form.SubmitButton disabled={!captcha.ready}>
              {t('auth.signIn.submit')}
            </form.SubmitButton>
          </form.AppForm>
          {methods.signUp && (
            <FieldDescription className="text-center">
              {t('auth.signIn.noAccount')}{' '}
              <Link to="/sign-up" search={{ redirect: props.redirect }}>
                {t('auth.signIn.signUp')}
              </Link>
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>
    </form>
  );
}

function MagicLinkRequest(props: {
  redirect?: string;
  onSent: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const captcha = useCaptcha('magic-link');
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: {
      onSubmit: z.object({ email: z.email(t('auth.fields.emailInvalid')) }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await unwrap(
          api.POST('/v1/auth/magic-link', {
            params: { header: captcha.header() },
            body: {
              email: value.email,
              ...(props.redirect && { redirectTo: props.redirect }),
            },
          }),
        );
        captcha.settle();
        props.onSent();
      } catch (caught) {
        if (captcha.settle(caught) || applyFieldErrors(form, caught)) {
          return;
        }
        setError(errorMessage(caught));
      }
    },
  });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          {t('auth.magicLink.hint')}
        </p>
        <FormAlert message={error} />
        <form.AppField name="email">
          {(field) => (
            <field.TextField
              label={t('auth.fields.email')}
              type="email"
              autoComplete="email"
              autoFocus
            />
          )}
        </form.AppField>
        {captcha.element}
        <Field>
          <form.AppForm>
            <form.SubmitButton disabled={!captcha.ready}>
              {t('auth.magicLink.send')}
            </form.SubmitButton>
          </form.AppForm>
          <Button type="button" variant="ghost" onClick={props.onBack}>
            {t('auth.signIn.withPassword')}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}

/** `google` → Google: the providers' names are brands, not translated. */
export function providerName(provider: string) {
  const names: Record<string, string> = {
    google: 'Google',
    microsoft: 'Microsoft',
    github: 'GitHub',
  };
  return (
    names[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}
