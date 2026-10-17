import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { MonitorSmartphoneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/date-time';
import { useSignOut } from '@/lib/sign-out';

export const sessionsQuery = queryOptions({
  queryKey: ['auth', 'sessions'],
  queryFn: () => unwrap(api.GET('/v1/auth/sessions')),
});

/** The account's sessions (how each signed in), revoke one, or all. */
export function SessionsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery(sessionsQuery);
  const signOutEverywhere = useSignOut(true);
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await api.DELETE('/v1/auth/sessions/{id}', { params: { path: { id } } });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey }),
  });
  return (
    <Section
      title={t('account.sessions.title')}
      description={t('account.sessions.description')}
    >
      {list.isPending ? (
        <Spinner />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {list.data?.items.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-center gap-3 p-3"
            >
              <MonitorSmartphoneIcon className="size-4 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {session.userAgent ?? t('account.sessions.unknownDevice')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    session.method &&
                      t(`account.sessions.methods.${session.method}`, {
                        provider: session.provider ?? '',
                      }),
                    t('account.sessions.lastActive', {
                      date: formatDateTime(session.lastActiveAt),
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              {session.current ? (
                <Badge>{t('account.sessions.current')}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(session.id)}
                >
                  {t('account.sessions.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmButton
        variant="destructive"
        title={t('account.sessions.everywhereTitle')}
        description={t('account.sessions.everywhereDescription')}
        confirm={t('account.sessions.everywhere')}
        onConfirm={() => signOutEverywhere.mutateAsync()}
      >
        {t('account.sessions.everywhere')}
      </ConfirmButton>
    </Section>
  );
}
