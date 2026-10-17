import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { api } from '@/lib/api';
import { createSession } from '@/lib/session';

/** Signs out (this session, or every one) and goes to sign-in. */
export function useSignOut(everywhere = false) {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.POST(
        everywhere ? '/v1/auth/sign-out-everywhere' : '/v1/auth/sign-out',
      );
    },
    // Signed out either way: an expired session answers 401, which is fine.
    onSettled: async () => {
      createSession(queryClient).clear();
      await router.navigate({ to: '/sign-in' });
    },
    meta: { errorToast: false },
  });
}
