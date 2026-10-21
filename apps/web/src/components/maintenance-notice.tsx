import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WrenchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/features';
import { featuresQuery } from '@/lib/session';
import { useSignOut } from '@/lib/sign-out';

/**
 * The whole signed-in app while the deployment is in maintenance
 * (`mode: 'maintenance'`, docs/settings.md): the API refuses everything but
 * health, sign-in and the operators' routes (503 `maintenance`), so no page
 * would show anything, and the layout renders this instead of the menu and
 * the page, which then ask for nothing. The mode is asked again by itself
 * (lib/mode.ts); "Check again" asks now. Signing out stays possible, and an
 * operator who may manage settings can end the mode here, by the route the
 * API keeps open for it (`DELETE /v1/settings/platform.mode/platform`).
 */
export function MaintenanceNotice() {
  const { t } = useTranslation('mode');
  const { t: tc } = useTranslation();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const operator = useMe()?.tenant?.operator === true;
  const canManage = useCan('Access.manageSettings');
  const refresh = () =>
    queryClient.refetchQueries({ queryKey: featuresQuery.queryKey });
  const check = useMutation({ mutationFn: refresh });
  // Only the platform value is the operators' to remove: an APP_MODE in the
  // environment has none, and the API answers that with an error the global
  // handler shows.
  const end = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/v1/settings/{key}/platform', {
          params: { path: { key: 'platform.mode' } },
        }),
      ),
    onSuccess: async () => {
      toast.success(t('maintenance.operator.ended'));
      await refresh();
    },
  });
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <WrenchIcon
          aria-hidden="true"
          className="size-10 text-muted-foreground"
        />
        <h1 className="text-xl font-medium">{t('maintenance.title')}</h1>
        <p role="status" className="text-muted-foreground">
          {t('maintenance.description')}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending && <Spinner />}
            {t('maintenance.check')}
          </Button>
          <Button
            variant="ghost"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {tc('auth.signOut')}
          </Button>
        </div>
        {operator && canManage && (
          <div className="flex flex-col items-center gap-2 border-t pt-4">
            <Button disabled={end.isPending} onClick={() => end.mutate()}>
              {end.isPending && <Spinner />}
              {t('maintenance.operator.end')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t('maintenance.operator.hint')}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
