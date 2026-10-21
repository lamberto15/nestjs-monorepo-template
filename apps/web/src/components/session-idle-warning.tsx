import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@nestjs-monorepo-template/ui/components/alert-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/lib/features';
import { meQuery } from '@/lib/session';

/** How long before the idle timeout the warning shows. */
export const WARN_BEFORE_MS = 2 * 60_000;
/** Input is passed on to the API (it counts as activity there) at most this often. */
const PING_EVERY_MS = 60_000;

/**
 * Warns two minutes before the session's idle timeout (`me.session`: the
 * tenant's `auth.sessionIdleMinutes` under the deployment's), and lets
 * the user stay signed in. The server ends a session after `idleMinutes`
 * without a request, so the page counts the user's own activity (pointer,
 * keys, scrolling) and passes it on by asking for `me` at most once a minute
 * (a request is what the server counts); with no input for
 * `idleMinutes - 2`, a dialog counts down. "Stay signed in" is such a
 * request. At zero the session is over: `me` answers 401 and the route
 * guard goes to sign-in.
 */
export function SessionIdleWarning() {
  const { t } = useTranslation();
  const me = useMe();
  const queryClient = useQueryClient();
  const router = useRouter();
  const idleMs = me?.session ? me.session.idleMinutes * 60_000 : null;
  const lastInput = useRef(0);
  const lastPing = useRef(0);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (idleMs === null) {
      return;
    }
    // The page was just shown or the policy just read: counted from now.
    lastInput.current = Date.now();
    lastPing.current = Date.now();
    const ping = async () => {
      lastPing.current = Date.now();
      await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
    };
    const onInput = () => {
      lastInput.current = Date.now();
      if (Date.now() - lastPing.current >= PING_EVERY_MS) {
        void ping().catch(() => undefined);
      }
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of events) {
      window.addEventListener(event, onInput, { passive: true });
    }
    const timer = setInterval(() => {
      const left = idleMs - (Date.now() - lastInput.current);
      if (left > WARN_BEFORE_MS) {
        setRemaining(null);
        return;
      }
      setRemaining(Math.max(0, left));
      if (left <= 0) {
        // Over: ask again; the 401 clears `me` and the guard signs out.
        clearInterval(timer);
        void ping()
          .catch(() => undefined)
          .finally(() => router.invalidate());
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      for (const event of events) {
        window.removeEventListener(event, onInput);
      }
    };
  }, [idleMs, queryClient, router]);

  const stay = async () => {
    lastInput.current = Date.now();
    lastPing.current = Date.now();
    setRemaining(null);
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
  };

  const seconds = Math.ceil((remaining ?? 0) / 1000);
  return (
    <AlertDialog open={remaining !== null && remaining > 0}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('auth.idle.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('auth.idle.description', {
              time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => void stay().catch(() => undefined)}>
            {t('auth.idle.stay')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
