import { useMutation, useQueryClient } from '@tanstack/react-query';
import { VenetianMaskIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/confirm-button';
import type { Member } from '@/features/access/api';
import { api } from '@/lib/api';
import { useCan, useFeature, useMe } from '@/lib/features';
import { createSession } from '@/lib/session';

/**
 * A full page load: everything in memory (queries, open dialogs, React state,
 * the socket) belonged to the administrator's session. `createSession().reset()`
 * removes queries without telling mounted ones (TanStack Query's
 * removeQueries), so the sidebar would keep showing the administrator. An
 * object, so tests can replace it (jsdom doesn't navigate).
 */
export const pageLoad = {
  to(path: string) {
    window.location.assign(path);
  },
};

/**
 * Act as a member (docs/auth.md, "Impersonation"): only with the switch on
 * and `Access.impersonate`, never oneself. The API asks for a recent sign-in
 * (the re-authenticate dialog answers it, lib/api.ts), refuses an
 * administrator, then replaces the session's cookie: like a tenant switch,
 * nothing cached belongs to the new session, and the dashboard is loaded
 * afresh (see `pageLoad`). The banner shows who is acting.
 */
export function ImpersonateButton(props: {
  member: Member;
  /** Holds a built-in role now: the API refuses (403). */
  administrator: boolean;
}) {
  const { t } = useTranslation('access');
  const on = useFeature('impersonation');
  const allowed = useCan('Access.impersonate');
  const me = useMe();
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: async () => {
      await api.POST('/v1/access/users/{id}/impersonate', {
        params: { path: { id: props.member.id } },
      });
    },
    onSuccess: async () => {
      await createSession(queryClient).reset();
      pageLoad.to('/');
    },
  });
  if (
    !on ||
    !allowed ||
    me?.user.impersonator ||
    me?.user.id === props.member.id ||
    !props.member.active ||
    props.administrator
  ) {
    return null;
  }
  return (
    <ConfirmButton
      size="sm"
      title={t('users.impersonate.title', { email: props.member.email })}
      description={t('users.impersonate.description')}
      confirm={t('users.impersonate.confirm')}
      onConfirm={() => start.mutateAsync()}
    >
      <VenetianMaskIcon />
      {t('users.impersonate.button')}
    </ConfirmButton>
  );
}
