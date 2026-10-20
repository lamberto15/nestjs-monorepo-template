import { useMutation } from '@tanstack/react-query';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';

// The API allows 3 resends per 15 minutes (docs/api-conventions.md, "Rate
// limits"); it does not say when the window ends, so a 429 locks the button
// for the whole window.
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

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
  const [limited, setLimited] = useState(false);
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
        setLimited(true);
      } else {
        toast.error(errorMessage(error));
      }
    },
  });
  useEffect(() => {
    if (!limited) {
      return;
    }
    const timer = setTimeout(() => setLimited(false), RATE_LIMIT_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [limited]);

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
