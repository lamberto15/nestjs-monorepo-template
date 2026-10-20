import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { LandmarkIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { safeRedirect } from '@/lib/safe-redirect';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Sign in with SSO": the browser goes to the connection's own login route,
 * which redirects to the identity provider (docs/auth.md, "Enterprise SSO").
 * The API cannot find a connection by email domain yet, so the person gives
 * the workspace and connection ids their administrator shows them (SSO page),
 * or arrives through the link the administrator sends.
 */
export function SsoSignIn(props: { redirect?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tenant, setTenant] = useState('');
  const [connection, setConnection] = useState('');
  const [error, setError] = useState<string>();

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
      onSubmit={(event) => {
        event.preventDefault();
        const ids = [tenant.trim(), connection.trim()];
        if (!ids.every((id) => UUID.test(id))) {
          setError(t('auth.sso.invalid'));
          return;
        }
        // A full navigation: the API redirects to the identity provider.
        window.location.assign(
          `/v1/auth/sso/${ids[0]}/${ids[1]}/login?redirectTo=${encodeURIComponent(safeRedirect(props.redirect))}`,
        );
      }}
    >
      <FieldGroup>
        <p className="text-sm text-muted-foreground">
          {t('auth.sso.description')}
        </p>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="sso-tenant">{t('auth.sso.tenant')}</FieldLabel>
          <Input
            id="sso-tenant"
            autoComplete="off"
            value={tenant}
            aria-invalid={Boolean(error)}
            onChange={(event) => setTenant(event.target.value)}
          />
        </Field>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="sso-connection">
            {t('auth.sso.connection')}
          </FieldLabel>
          <Input
            id="sso-connection"
            autoComplete="off"
            value={connection}
            aria-invalid={Boolean(error)}
            onChange={(event) => setConnection(event.target.value)}
          />
          {error && (
            <FieldDescription role="alert" className="text-destructive">
              {error}
            </FieldDescription>
          )}
        </Field>
        <div className="flex gap-2">
          <Button type="submit">{t('auth.sso.continue')}</Button>
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
