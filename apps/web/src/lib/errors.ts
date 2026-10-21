import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { AnyFormApi } from '@tanstack/react-form';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { toast } from 'sonner';
import { i18n } from '@/i18n';
import { isModeRefusal } from '@/lib/mode';
import { createSession, featuresQuery, meQuery } from '@/lib/session';

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: ErrorMeta;
    mutationMeta: ErrorMeta;
  }
}

export type ErrorMeta = {
  /** false: the caller shows the error itself (a form, a page). */
  errorToast?: boolean;
};

/** Where the global handler sends a user whose session ended. */
export type ErrorHandlerTarget = {
  /** The page to come back to after signing in again. */
  currentHref(): string;
  /** Whether that page is one of the signed-in app (not sign-in, a link's). */
  inApp(): boolean;
  toSignIn(redirect: string): void;
  /** To the two-factor setup page (a no-op when already there). */
  toMfaSetup(): void;
};

/**
 * The session ended under the user (idle or absolute limit, signed out in
 * another tab, an impersonation ended): forget the user and their data and,
 * on a page of the signed-in app, go to sign-in, back here afterwards.
 * Whoever notices first does it; `me` is null afterwards, so it runs once.
 */
export function endSession(
  queryClient: QueryClient,
  target: ErrorHandlerTarget | undefined,
) {
  createSession(queryClient).clear();
  if (target?.inApp()) {
    target.toSignIn(target.currentHref());
  }
}

/**
 * Every query and mutation error goes through here (TanStack Query's
 * QueryCache/MutationCache `onError`):
 *
 * - 401: never a toast. While signed in, the session ended (endSession);
 *   once it is cleared, the other requests that failed with it say nothing.
 *   A 401 while nobody is signed in (a wrong password) is the form's.
 * - 403 `reauthentication_required` never gets here unless the user gave up
 *   the re-authenticate dialog (lib/api.ts retries after it): nothing to say.
 * - 403 `mfa_enrollment_required` (the tenant requires two-factor and the user
 *   has none): to the setup page with one explanatory toast, not the raw error.
 * - 503 `read_only` / `maintenance` (the deployment's mode, docs/settings.md):
 *   the mode is asked again at once, so the banner or the full-page notice
 *   shows; one toast however many requests were refused (the id dedupes).
 * - Anything else: a toast with the problem's `detail` (in the request's
 *   language), unless the caller shows it (`meta: { errorToast: false }`).
 */
export function handleApiError(
  queryClient: QueryClient,
  target: ErrorHandlerTarget | undefined,
  error: unknown,
  meta: ErrorMeta | undefined,
) {
  if (isApiError(error)) {
    if (error.status === 401) {
      if (queryClient.getQueryData(meQuery.queryKey)) {
        endSession(queryClient, target);
      }
      return;
    }
    if (error.code === 'reauthentication_required') {
      return;
    }
    if (error.code === 'mfa_enrollment_required') {
      if (target?.inApp()) {
        // One toast however many queries failed with it (the id dedupes).
        toast.info(i18n.t('account.mfa.redirected'), {
          id: 'mfa-enrollment-required',
        });
        target.toMfaSetup();
      }
      return;
    }
    if (isModeRefusal(error)) {
      // Not cancelling a refetch under way: a page of failed requests asks
      // this once per request, and each would restart the one before.
      void queryClient.invalidateQueries(
        { queryKey: featuresQuery.queryKey },
        { cancelRefetch: false },
      );
      if (meta?.errorToast !== false) {
        toast.error(errorMessage(error), { id: 'deployment-mode' });
      }
      return;
    }
  }
  if (meta?.errorToast === false) {
    return;
  }
  toast.error(errorMessage(error));
}

/** What to tell the user about an error. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    return error.detail;
  }
  return i18n.t('auth.errors.network');
}

export function createQueryClient(
  target: () => ErrorHandlerTarget | undefined,
) {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) =>
        handleApiError(queryClient, target(), error, query.meta),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) =>
        handleApiError(queryClient, target(), error, mutation.meta),
    }),
    defaultOptions: {
      queries: {
        // A 4xx won't change by asking again.
        retry: (count, error) =>
          !(isApiError(error) && error.status < 500) && count < 2,
      },
    },
  });
  watchSession(queryClient, target);
  return queryClient;
}

/**
 * `me` refetched (a window focus, an invalidation) and nobody is signed in
 * any more: the session ended without a 401 anyone else saw. A null that
 * the app set itself (sign-out, endSession: setQueryData) is no news.
 */
function watchSession(
  queryClient: QueryClient,
  target: () => ErrorHandlerTarget | undefined,
) {
  const meHash = JSON.stringify(meQuery.queryKey);
  let signedIn = false;
  queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash !== meHash) {
      return;
    }
    if (event.type === 'removed') {
      signedIn = false;
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success') {
      return;
    }
    const now = event.action.data != null;
    if (signedIn && !now && !event.action.manual) {
      signedIn = false;
      endSession(queryClient, target());
      return;
    }
    signedIn = now;
  });
}

/**
 * A `validation_failed` (or any problem with `errors`) shown on the form's
 * fields: each `errors[].path` that names a field gets its message, as a
 * submit error (TanStack Form clears it when the field changes; `aliases`
 * maps a path to a field of another name). Returns
 * whether any field took one; the rest is the caller's (a form-level alert).
 */
export function applyFieldErrors(
  form: AnyFormApi,
  error: unknown,
  /** Form fields named otherwise than the API's paths: path → field. */
  aliases: Record<string, string> = {},
): boolean {
  if (!isApiError(error) || !error.errors?.length) {
    return false;
  }
  const fields = new Set(Object.keys(form.state.values as object));
  let applied = false;
  for (const fieldError of error.errors) {
    const name = aliases[fieldError.path] ?? fieldError.path;
    if (!fields.has(name)) {
      continue;
    }
    applied = true;
    form.setFieldMeta(name, (meta) => ({
      ...meta,
      isTouched: true,
      errorMap: {
        ...meta?.errorMap,
        onSubmit: { message: fieldError.message },
      },
    }));
  }
  return applied;
}
