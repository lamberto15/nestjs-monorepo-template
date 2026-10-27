import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from '@/lib/zod';
import { languages } from '@/i18n';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { api } from '@/lib/api';
import { AvatarSection } from '@/components/account/avatar-section';
import { useMe } from '@/lib/features';
import { FormAlert, useAppForm } from '@/lib/form';
import { browserTimeZone } from '@/lib/link-token';
import { peopleKey } from '@/lib/people';
import { meQuery, type Me } from '@/lib/session';

export const Route = createFileRoute('/_app/account/profile')({
  component: ProfilePage,
});

function ProfilePage() {
  const { t } = useTranslation();
  const me = useMe();
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-medium">{t('account.profile.title')}</h1>
      {me && <ProfileForm me={me} />}
    </div>
  );
}

/** `PATCH /v1/auth/me`: name, language (the UI follows), time zone. */
function ProfileForm({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const impersonating = !!me.user.impersonator;
  const timeZones = useMemo(() => {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.map((zone) => ({
      value: zone,
      label: zone.replaceAll('_', ' '),
    }));
  }, []);
  const save = useMutation({
    mutationFn: (body: { name: string; locale: string; timezone: string }) =>
      unwrap(
        api.PATCH('/v1/auth/me', {
          body: {
            name: body.name,
            locale: body.locale || null,
            timezone: body.timezone || null,
          },
        }),
      ),
    meta: { errorToast: false },
  });
  const form = useAppForm({
    defaultValues: {
      name: me.user.name,
      locale: me.user.locale ?? '',
      timezone: me.user.timezone ?? '',
    },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, t('auth.fields.nameRequired')).max(120),
        locale: z.string(),
        timezone: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const user = await save.mutateAsync({
          ...value,
          name: value.name.trim(),
        });
        queryClient.setQueryData(meQuery.queryKey, (old) =>
          old ? { ...old, user } : old,
        );
        // The name is cached for others to see: audit actors, owner cells,
        // mention pickers.
        void queryClient.invalidateQueries({ queryKey: peopleKey });
        const language = languages.find((x) => x === user.locale);
        if (language && language !== i18n.language) {
          await i18n.changeLanguage(language);
        }
        toast.success(t('account.profile.saved'));
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account.profile.title')}</CardTitle>
        <CardDescription>
          {impersonating
            ? t('account.impersonating')
            : t('account.profile.description')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            <AvatarSection me={me} />
            <Field>
              <FieldLabel htmlFor="account-email">
                {t('auth.fields.email')}
              </FieldLabel>
              <Input
                id="account-email"
                value={me.user.email}
                readOnly
                disabled
              />
              <FieldDescription>
                {t('account.profile.emailHint')}
              </FieldDescription>
            </Field>
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label={t('auth.fields.name')}
                  autoComplete="name"
                />
              )}
            </form.AppField>
            <form.AppField name="locale">
              {(field) => (
                <field.SelectField
                  label={t('preferences.language')}
                  options={languages.map((value) => ({
                    value,
                    label: t(`languages.${value}`),
                  }))}
                />
              )}
            </form.AppField>
            <form.AppField name="timezone">
              {(field) => (
                <field.SelectField
                  label={t('account.profile.timezone')}
                  placeholder={browserTimeZone()}
                  options={timeZones}
                />
              )}
            </form.AppField>
            <form.AppForm>
              <form.SubmitButton
                className="self-start"
                disabled={impersonating}
              >
                {t('account.save')}
              </form.SubmitButton>
            </form.AppForm>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
