import { useMutation } from '@tanstack/react-query';
import { isApiError, unwrap } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useCaptcha } from '@/components/auth/captcha';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';

// The API allows 3 resends per 15 minutes for a session, and 5 per email and
// address for the public resend (docs/api-conventions.md, "Rate limits"); it
// does not say when the window ends, so a 429 locks every button of its kind
// for the whole window. A lock is shared (the banner and the verify-email page
// each have a button) and kept in sessionStorage, so a reload does not hand
// out a fresh button. The signed-in resend has one lock; the public one has
// one per email address, since the API counts per address.
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const SESSION_LOCK = 'resend-verification-locked-until';

// Memory is the fallback for a browser that blocks storage.
const memoryLocks = new Map<string, number>();
const listeners = new Set<() => void>();

function readLock(key: string): number {
  try {
    return Number(sessionStorage.getItem(key)) || 0;
  } catch {
    return memoryLocks.get(key) ?? 0;
  }
}

function lock(key: string) {
  const until = Date.now() + RATE_LIMIT_WINDOW_MS;
  memoryLocks.set(key, until);
  try {
    sessionStorage.setItem(key, String(until));
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
function useLimited(key: string): boolean {
  const until = useSyncExternalStore(
    subscribe,
    () => readLock(key),
    () => 0,
  );
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
  const limited = useLimited(SESSION_LOCK);
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
        lock(SESSION_LOCK);
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

/**
 * "Send the link again" for an account with no session (a sign-up that has
 * not proved its address; sign-in answers 403 `email_unverified`):
 * `POST /v1/auth/email/verification/resend { email }`. The API answers 202
 * whatever the address, so the confirmation is always the same neutral line.
 * The bot check (Turnstile action `resend-verification`) is shown when
 * `GET /v1/auth/methods` or a 403 `captcha_required` asks, as on the forgot
 * password page. After a 429 (`rate_limited`, 5 per email and address every
 * 15 minutes) the button stays off, with the reason, until the window passes.
 */
export function ResendVerificationByEmail(props: { email: string }) {
  const { t } = useTranslation();
  const email = props.email.trim();
  const limited = useLimited(`${SESSION_LOCK}:${email.toLowerCase()}`);
  const captcha = useCaptcha('resend-verification');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const resend = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/v1/auth/email/verification/resend', {
          params: { header: captcha.header() },
          body: { email },
        }),
      ),
    // Handled here: inline for the 429 and the confirmation, a message for
    // the rest.
    meta: { errorToast: false },
    onMutate: () => {
      setError(undefined);
    },
    onSuccess: () => {
      captcha.settle();
      setSent(true);
    },
    onError: (caught) => {
      if (captcha.settle(caught)) {
        return;
      }
      if (isApiError(caught) && caught.status === 429) {
        lock(`${SESSION_LOCK}:${email.toLowerCase()}`);
      } else {
        setError(errorMessage(caught));
      }
    },
  });
  return (
    <div className="flex flex-col gap-2">
      {captcha.element}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={resend.isPending || limited || !captcha.ready}
          onClick={() => resend.mutate()}
        >
          {resend.isPending && <Spinner />}
          {t('auth.verify.resend.again')}
        </Button>
        {limited && (
          <span role="status" className="text-sm text-muted-foreground">
            {t('auth.verify.resend.limited')}
          </span>
        )}
      </div>
      {sent && !limited && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('auth.verify.resend.sent')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
