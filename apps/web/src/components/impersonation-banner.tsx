import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { VenetianMaskIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useMe } from '@/lib/features';
import { createSession } from '@/lib/session';

/**
 * While an administrator acts as a user (`me.user.impersonator`): who, and
 * the way back to their own session (`POST /v1/auth/impersonation/stop`).
 */
export function ImpersonationBanner() {
  const { t } = useTranslation();
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: async () => {
      await api.POST('/v1/auth/impersonation/stop');
    },
    onSuccess: async () => {
      await createSession(queryClient).reset();
      // The session changed already: a form's unsaved-changes guard would
      // hold a page of the previous one (lib/unsaved-changes.ts).
      await router.navigate({ to: '/', ignoreBlocker: true });
      await router.invalidate();
    },
  });
  const impersonator = me?.user.impersonator;
  if (!me || !impersonator) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100"
    >
      <VenetianMaskIcon className="size-4 shrink-0" />
      <span className="flex-1">
        {t('auth.impersonation.banner', {
          user: me.user.email,
          administrator: impersonator.email,
        })}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={stop.isPending}
        onClick={() => stop.mutate()}
      >
        {stop.isPending && <Spinner />}
        {t('auth.impersonation.stop')}
      </Button>
    </div>
  );
}
