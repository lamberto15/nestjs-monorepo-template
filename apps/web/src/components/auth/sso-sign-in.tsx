import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { LandmarkIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useDescribedBy } from '@/lib/form';
import { safeRedirect } from '@/lib/safe-redirect';

const LOGIN_PATH = '/v1/auth/sso/';

/**
 * Where the browser may go for an SSO sign-in: the API's own login route
 * (`/v1/auth/sso/...`), relative or on this origin, with `redirectTo` added.
 * Anything else the answer could hold (another origin, `//host`, `/\host`,
 * `javascript:`) is refused, so a wrong answer is never an open redirect.
 */
export function ssoLoginTarget(
  loginUrl: string,
  redirect: string | undefined,
  origin = window.location.origin,
): string | undefined {
  let url: URL;
  try {
    url = new URL(loginUrl, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin || !url.pathname.startsWith(LOGIN_PATH)) {
    return undefined;
  }
  url.searchParams.set('redirectTo', safeRedirect(redirect));
  return `${url.pathname}${url.search}`;
}

/**
 * "Sign in with SSO": the person gives their email, the API finds the
 * connection of its domain (POST /v1/auth/sso/discover, docs/auth.md,
 * "Finding the connection by address") and the browser goes to its login
 * route, which redirects to the identity provider. The answer is the same
 * whether or not the domain has SSO, so the message for "none" doesn't say.
 */
export function SsoSignIn(props: { redirect?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState(false);
  // The error describes the address (as lib/form.tsx's fields).
  const { controlId, errorId, describedBy } = useDescribedBy(
    false,
    Boolean(error),
  );

  if (!open) {
    return (
      <Button variant="outline" type="button" onClick={() => setOpen(true)}>
        <LandmarkIcon />
        {t('auth.sso.button')}
      </Button>
    );
  }
  return (
    <form
      noValidate
      className="flex flex-col gap-4 rounded-md border p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(undefined);
        setNone(false);
        const address = email.trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
          setError(t('auth.fields.emailInvalid'));
          return;
        }
        setBusy(true);
        try {
          const { loginUrl } = await unwrap(
            api.POST('/v1/auth/sso/discover', { body: { email: address } }),
          );
          const target = loginUrl
            ? ssoLoginTarget(loginUrl, props.redirect)
            : undefined;
          if (!target) {
            setNone(true);
            return;
          }
          // A full navigation: the API redirects to the identity provider.
          window.location.assign(target);
        } catch {
          setError(t('auth.sso.failed'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          {t('auth.sso.description')}
        </p>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor={controlId}>{t('auth.fields.email')}</FieldLabel>
          <Input
            id={controlId}
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            onChange={(event) => setEmail(event.target.value)}
          />
          {error && (
            <FieldDescription
              id={errorId}
              role="alert"
              className="text-destructive"
            >
              {error}
            </FieldDescription>
          )}
          {none && (
            <FieldDescription role="status">
              {t('auth.sso.none')}
            </FieldDescription>
          )}
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {t('auth.sso.continue')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            {t('auth.sso.cancel')}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
