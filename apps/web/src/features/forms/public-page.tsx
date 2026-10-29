import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '@/components/auth/auth-layout';
import { useCaptcha } from '@/components/auth/captcha';
import { api } from '@/lib/api';
import { FormFill } from './fill-page';

/**
 * A form opened by its public link, without an account: the published
 * version the link opens, filled in and sent with the token in the body,
 * past the bot challenge when the deployment has one (action
 * `public-form`). Every refusal of the link is the API's one 404: the page
 * says the link doesn't work, and nothing more.
 */
export function PublicFormPage() {
  const { t } = useTranslation('forms');
  // The link's token: what follows `#` (never sent to a server by the browser).
  const token = decodeURIComponent(
    useLocation({ select: (location) => location.hash }).replace(/^#/, ''),
  );
  const [sent, setSent] = useState(false);
  const captcha = useCaptcha('public-form');
  const form = useQuery({
    queryKey: ['public-form', token],
    queryFn: () =>
      unwrap(api.POST('/v1/public/forms/open', { body: { token } })),
    enabled: token.length > 0,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    meta: { errorToast: false },
  });
  const submit = useMutation({
    mutationFn: (body: {
      versionId: string;
      answers: Record<string, unknown>;
    }) =>
      unwrap(
        api.POST('/v1/public/forms/submit', {
          params: { header: captcha.header() },
          body: { token, ...body },
        }),
      ),
    meta: { errorToast: false },
  });

  if (!token || form.isError) {
    return (
      <AuthLayout title={t('public.title')}>
        <p role="alert" className="text-sm text-muted-foreground">
          {t('public.invalid')}
        </p>
      </AuthLayout>
    );
  }
  if (form.isPending) {
    return (
      <AuthLayout title={t('public.title')}>
        <Skeleton className="h-64 w-full" aria-busy />
      </AuthLayout>
    );
  }
  if (sent) {
    return (
      <AuthLayout title={form.data.name}>
        <p role="status">{t('sent')}</p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={form.data.name}
      description={form.data.description ?? undefined}
    >
      <FormFill
        definition={form.data.definition}
        pending={submit.isPending}
        footer={captcha.element}
        ready={captcha.ready}
        send={async (answers) => {
          try {
            await submit.mutateAsync({
              versionId: form.data.versionId,
              answers,
            });
            captcha.settle();
            setSent(true);
          } catch (error) {
            captcha.settle(error);
            throw error;
          }
        }}
      />
    </AuthLayout>
  );
}
