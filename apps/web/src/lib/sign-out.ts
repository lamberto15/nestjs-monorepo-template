import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import { createSession } from '@/lib/session';

/**
 * Signs out (this session, or every one) and goes to sign-in. A 401 means
 * the session was over already: signed out all the same. Any other failure
 * (the API unreachable, a 5xx) leaves the user signed in, and the global
 * handler says why.
 */
export function useSignOut(everywhere = false) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const signedOut = async () => {
    createSession(queryClient).clear();
    await router.navigate({ to: '/sign-in' });
  };
  return useMutation({
    mutationFn: async () => {
      try {
        await api.POST(
          everywhere ? '/v1/auth/sign-out-everywhere' : '/v1/auth/sign-out',
        );
      } catch (error) {
        if (isApiError(error) && error.status === 401) {
          return;
        }
        throw error;
      }
    },
    onSuccess: signedOut,
  });
}
