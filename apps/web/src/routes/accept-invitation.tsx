import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { isApiError, unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
} from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from '@/lib/zod';
import { AuthLayout } from '@/components/auth/auth-layout';
import { LinkResult, MissingToken } from '@/components/auth/link-result';
import { api } from '@/lib/api';
import { AUTH_LIMITS } from '@/lib/auth-limits';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { tokenSearchSchema } from '@/lib/link-token';
import { createSession, meQuery } from '@/lib/session';
import { useSignOut } from '@/lib/sign-out';

// An invitation's link (docs/tenancy.md, "Accounts and sessions"): a new
// address chooses its name and password here; an existing account accepts
// signed in as itself (401 `sign_in_required` otherwise).
export const Route = createFileRoute('/accept-invitation')({
  validateSearch: tokenSearchSchema,
  component: AcceptInvitationPage,
});

function AcceptInvitationPage() {
  const { t } = useTranslation();
  const { token } = Route.useSearch();
  const me = useQuery(meQuery);
  return (
    <AuthLayout
      title={t('auth.invitation.title')}
      description={t('auth.invitation.description')}
    >
      {!token ? (
        <MissingToken />
      ) : me.isPending ? (
        <Spinner className="mx-auto" />
      ) : me.data ? (
        <AcceptSignedIn token={token} email={me.data.user.email} />
      ) : (
        <AcceptNewAccount token={token} />
      )}
    </AuthLayout>
  );
}

function AcceptSignedIn(props: { token: string; email: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <FieldGroup>
      <FormAlert message={error} />
      <p className="text-center text-sm text-muted-foreground">
        {t('auth.invitation.signedInAs', { email: props.email })}
      </p>
      <Field>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              const { tenantId } = await unwrap(
                api.POST('/v1/auth/invitations/accept', {
                  body: { token: props.token },
                }),
              );
              // On into the tenant just joined.
              await api.POST('/v1/auth/tenant', { body: { tenantId } });
              await createSession(queryClient).reset();
              await router.navigate({ to: '/' });
            } catch (caught) {
              setError(errorMessage(caught));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />}
          {t('auth.invitation.accept')}
        </Button>
        <Button variant="ghost" onClick={() => signOut.mutate()}>
          {t('auth.invitation.notYou')}
        </Button>
      </Field>
    </FieldGroup>
  );
}

function AcceptNewAccount(props: { token: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const [signInFirst, setSignInFirst] = useState(false);
  const [created, setCreated] = useState(false);
  const back = `/accept-invitation?token=${encodeURIComponent(props.token)}`;
  const form = useAppForm({
    defaultValues: { name: '', password: '' },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('auth.fields.nameRequired'))
          .max(
            AUTH_LIMITS.name,
            t('auth.fields.nameTooLong', { max: AUTH_LIMITS.name }),
          ),
        password: z
          .string()
          .min(
            AUTH_LIMITS.passwordMin,
            t('auth.fields.passwordTooShort', { min: AUTH_LIMITS.passwordMin }),
          )
          .max(
            AUTH_LIMITS.passwordMax,
            t('auth.fields.passwordTooLong', { max: AUTH_LIMITS.passwordMax }),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await unwrap(
          api.POST('/v1/auth/invitations/accept', {
            body: {
              token: props.token,
              name: value.name.trim(),
              password: value.password,
            },
          }),
        );
        setCreated(true);
      } catch (caught) {
        if (isApiError(caught) && caught.code === 'sign_in_required') {
          setSignInFirst(true);
          return;
        }
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  if (created) {
    return (
      <LinkResult
        ok
        action={
          <Button
            nativeButton={false}
            render={<Link to="/sign-in" search={{ redirect: '/' }} />}
          >
            {t('auth.signIn.title')}
          </Button>
        }
      >
        {t('auth.invitation.created')}
      </LinkResult>
    );
  }
  if (signInFirst) {
    return (
      <LinkResult
        ok={false}
        action={
          <Button
            nativeButton={false}
            render={<Link to="/sign-in" search={{ redirect: back }} />}
          >
            {t('auth.signIn.title')}
          </Button>
        }
      >
        {t('auth.invitation.signInFirst')}
      </LinkResult>
    );
  }
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <FormAlert message={error} />
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label={t('auth.fields.name')}
              autoComplete="name"
            />
          )}
        </form.AppField>
        <form.AppField name="password">
          {(field) => (
            <field.TextField
              label={t('auth.fields.password')}
              type="password"
              autoComplete="new-password"
              description={t('auth.fields.passwordHint')}
            />
          )}
        </form.AppField>
        <Field>
          <form.AppForm>
            <form.SubmitButton>{t('auth.invitation.create')}</form.SubmitButton>
          </form.AppForm>
          <FieldDescription className="text-center">
            {t('auth.invitation.haveAccount')}{' '}
            <Link to="/sign-in" search={{ redirect: back }}>
              {t('auth.signIn.title')}
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
