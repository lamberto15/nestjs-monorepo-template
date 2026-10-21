import { useMutation, useQueryClient } from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from '@/lib/zod';
import { Section } from '@/components/account/section';
import { ResendVerification } from '@/components/auth/resend-verification';
import { api } from '@/lib/api';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import { FormAlert, useAppForm } from '@/lib/form';
import { meQuery } from '@/lib/session';

/**
 * The first administrator's email step (`POST /v1/auth/email/change`): a
 * real address replaces the placeholder, then its link must be opened.
 */
export function OnboardingEmailSection() {
  const { t } = useTranslation();
  const me = useMe();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  // The API changes the address at once: it is the user's while unproved.
  const sent = me && !me.user.emailVerified;
  const change = useMutation({
    mutationFn: async (body: { email: string; currentPassword: string }) => {
      await unwrap(api.POST('/v1/auth/email/change', { body }));
    },
    meta: { errorToast: false },
  });
  const form = useAppForm({
    defaultValues: { email: '', currentPassword: '' },
    validators: {
      onSubmit: z.object({
        email: z.email(),
        currentPassword: z.string().min(1),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await change.mutateAsync(value);
        form.setFieldValue('currentPassword', '');
        await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
        toast.success(t('onboarding.emailSent', { email: value.email }));
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Section
      title={t('onboarding.emailTitle')}
      description={t('onboarding.emailDescription')}
    >
      {sent && me && (
        <div className="flex flex-col gap-3 text-sm">
          <p>{t('onboarding.emailWaiting', { email: me.user.email })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                void queryClient.invalidateQueries({
                  queryKey: meQuery.queryKey,
                })
              }
            >
              {t('onboarding.check')}
            </Button>
            <ResendVerification size="default" />
          </div>
        </div>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <FormAlert message={error} />
          <form.AppField name="email">
            {(field) => (
              <field.TextField
                label={t('onboarding.email')}
                type="email"
                autoComplete="email"
              />
            )}
          </form.AppField>
          <form.AppField name="currentPassword">
            {(field) => (
              <field.TextField
                label={t('onboarding.currentPassword')}
                type="password"
                autoComplete="current-password"
              />
            )}
          </form.AppField>
          <form.AppForm>
            <form.SubmitButton className="self-start">
              {t('onboarding.emailSubmit')}
            </form.SubmitButton>
          </form.AppForm>
        </FieldGroup>
      </form>
    </Section>
  );
}
