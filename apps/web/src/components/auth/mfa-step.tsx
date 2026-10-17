import { unwrap } from '@nestjs-monorepo-template/api-client';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from '@/lib/zod';
import { useCaptcha } from '@/components/auth/captcha';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import type { SignInResult } from '@/lib/sign-in';

/**
 * The second step of a sign-in with two-factor on: an authenticator's code,
 * or one of the recovery codes (`POST /v1/auth/mfa/verify`). The pending
 * session is the cookie the first step set.
 */
export function MfaStep(props: {
  onSignedIn: (result: SignInResult) => Promise<void>;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string>();
  const captcha = useCaptcha('sign-in');
  const form = useAppForm({
    defaultValues: { code: '', recoveryCode: '' },
    validators: {
      onSubmit: z.object({
        code: recovery
          ? z.string()
          : z.string().regex(/^\d{6}$/, t('auth.mfa.codeInvalid')),
        recoveryCode: recovery
          ? z.string().trim().min(1, t('auth.mfa.recoveryRequired'))
          : z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const result = await unwrap(
          api.POST('/v1/auth/mfa/verify', {
            params: { header: captcha.header() },
            body: recovery
              ? { recoveryCode: value.recoveryCode.trim() }
              : { code: value.code },
          }),
        );
        captcha.settle();
        await props.onSignedIn(result);
      } catch (caught) {
        if (captcha.settle(caught) || applyFieldErrors(form, caught)) {
          return;
        }
        setError(errorMessage(caught));
        form.setFieldValue('code', '');
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
        <p className="text-center text-sm text-muted-foreground">
          {recovery ? t('auth.mfa.recoveryHint') : t('auth.mfa.hint')}
        </p>
        <FormAlert message={error} />
        {recovery ? (
          <form.AppField name="recoveryCode">
            {(field) => (
              <field.TextField
                label={t('auth.mfa.recoveryCode')}
                autoComplete="off"
                autoFocus
              />
            )}
          </form.AppField>
        ) : (
          <form.AppField name="code">
            {(field) => (
              <field.CodeField
                label={t('auth.mfa.code')}
                autoFocus
                onComplete={() => void form.handleSubmit()}
              />
            )}
          </form.AppField>
        )}
        {captcha.element}
        <form.AppForm>
          <form.SubmitButton disabled={!captcha.ready}>
            {t('auth.mfa.verify')}
          </form.SubmitButton>
        </form.AppForm>
        <div className="flex justify-between text-sm">
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={() => {
              setRecovery(!recovery);
              setError(undefined);
            }}
          >
            {recovery ? t('auth.mfa.useCode') : t('auth.mfa.useRecovery')}
          </Button>
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={props.onRestart}
          >
            {t('auth.mfa.restart')}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
