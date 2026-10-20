import { useMutation } from '@tanstack/react-query';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';

// The API allows 3 resends per 15 minutes (docs/api-conventions.md, "Rate
// limits"); it does not say when the window ends, so a 429 locks every
// resend button for the whole window. The lock is shared (the banner and the
// verify-email page each have a button) and kept in sessionStorage, so a
// reload does not hand out a fresh button.
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const LOCK_KEY = 'resend-verification-locked-until';

// Memory is the fallback for a browser that blocks storage.
let memoryLock = 0;
const listeners = new Set<() => void>();

function readLock(): number {
  try {
    return Number(sessionStorage.getItem(LOCK_KEY)) || 0;
  } catch {
    return memoryLock;
  }
}

function lock() {
  memoryLock = Date.now() + RATE_LIMIT_WINDOW_MS;
  try {
    sessionStorage.setItem(LOCK_KEY, String(memoryLock));
  } catch {
    // memory only
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the resend is locked (a 429 not yet 15 minutes old). */
function useLimited(): boolean {
  const until = useSyncExternalStore(subscribe, readLock, () => 0);
  const limited = until > Date.now();
  // Only schedules the render that finds the lock gone.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!limited) {
      return;
    }
    const timer = setTimeout(rerender, until - Date.now());
    return () => clearTimeout(timer);
  }, [limited, until]);
  return limited;
}

/**
 * Whether the signed-in user's address is still unproved: the only one who
 * can ask for the link again (`POST /v1/auth/email/verification` is for a
 * session; while an administrator acts as the user it isn't theirs to ask).
 */
export function useUnverifiedUser() {
  const user = useMe()?.user;
  return user && !user.emailVerified && !user.impersonator ? user : undefined;
}

/**
 * "Send the verification link again": a toast on success; after a 429
 * (`rate_limited`) the button stays off, with the reason beside it, until the
 * limit's window has passed. Any other failure is a toast with the problem.
 */
export function ResendVerification(props: {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'link';
  size?: 'default' | 'sm';
}) {
  const { t } = useTranslation();
  const limited = useLimited();
  const resend = useMutation({
    mutationFn: async () => {
      await api.POST('/v1/auth/email/verification');
    },
    // The 429 is shown inline and every other error here, as a toast.
    meta: { errorToast: false },
    onSuccess: () => {
      toast.success(t('auth.verify.resend.done'));
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 429) {
        lock();
      } else {
        toast.error(errorMessage(error));
      }
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant={props.variant ?? 'outline'}
        size={props.size}
        disabled={resend.isPending || limited}
        onClick={() => resend.mutate()}
      >
        {resend.isPending && <Spinner />}
        {t('auth.verify.resend.button')}
      </Button>
      {limited && (
        <span role="status" className="text-sm text-muted-foreground">
          {t('auth.verify.resend.limited')}
        </span>
      )}
    </div>
  );
}
