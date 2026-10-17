import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { createSession } from '@/lib/session';
import { safeRedirect } from '@/lib/safe-redirect';

/** What every sign-in answers (password, passkey, link, second factor). */
export type SignInResult = {
  signedIn: boolean;
  mfaRequired: boolean;
  redirectTo?: string;
};

/**
 * After a sign-in: a new session, so nothing cached is kept; then on to the
 * page the user came for (only a path of this app).
 */
export function useFinishSignIn() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return async (redirect: string | undefined, result?: SignInResult) => {
    await createSession(queryClient).reset();
    const target = safeRedirect(redirect ?? result?.redirectTo);
    await router.navigate({ href: target, replace: true });
  };
}
