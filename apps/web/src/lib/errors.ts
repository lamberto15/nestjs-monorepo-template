import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import type { AnyFormApi } from '@tanstack/react-form';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { toast } from 'sonner';
import { i18n } from '@/i18n';
import { focusFirstInvalid } from '@/lib/form-focus';
import { isModeRefusal } from '@/lib/mode';
import { announceSessionIdentity, onSessionIdentity } from '@/lib/session-bus';
import {
  createSession,
  featuresQuery,
  meQuery,
  sessionIdentity,
  sessionWatch,
} from '@/lib/session';

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
  /** The first administrator's onboarding page. */
  toOnboarding(): void;
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
 * - 403 `onboarding_required` (the first administrator still has the
 *   placeholder email or generated password): to the onboarding page, explained.
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
    if (error.code === 'onboarding_required') {
      if (target?.inApp()) {
        toast.info(i18n.t('onboarding.redirected'), {
          id: 'onboarding-required',
        });
        target.toOnboarding();
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
    // The field errors no field of the form showed (applyFieldErrors): what
    // the form-level alert says, not the problem's generic `detail`.
    return unplaced.get(error)?.join('; ') ?? error.detail;
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
        // A 4xx won't change by asking again, nor will the deployment's
        // mode (503 `read_only` / `maintenance`: the API says to wait 30 s,
        // and the mode watch asks when it has ended). Retrying those held a
        // save, which refreshes pages the mode now refuses, for three seconds.
        retry: (count, error) =>
          !(
            isApiError(error) &&
            (error.status < 500 || isModeRefusal(error))
          ) && count < 2,
      },
    },
  });
  watchSession(queryClient, target);
  return queryClient;
}

/**
 * `me` refetched (a window focus, an invalidation, a route guard) answers
 * with the session's ends and its identity's changes (`sessionIdentity`):
 *
 * - The same identity as last seen, or one a reset or clear of this tab is
 *   applying itself (they record and announce it): nothing to do, the cache
 *   keeps its data.
 * - Nobody signed in (null), and not what the app set itself (sign out,
 *   endSession: setQueryData): the session ended without a 401 anyone else
 *   saw. `endSession` clears the data and the mutations; its `clear` tells
 *   the other tabs, so they end theirs at once too (`watchSession` below
 *   hears it there).
 * - A different identity signed in (another user or tenant, an impersonation
 *   started or stopped): the cookie was re-issued for another context —
 *   switched in this tab (whose flow's `reset` announces the outcome), or in
 *   another tab, which announced it and the identity this refetch answers is
 *   the re-issued cookie's. Either way the previous context's queries and
 *   mutations are forgotten the same way as by the tab that switched
 *   (`createSession().reset()`: every query back to its initial state, its
 *   in-flight fetch cancelled, the mounted ones refetched under the new
 *   cookie), so no record of the old tenant is shown or submitted as the
 *   new one's.
 * - The first identity this tab has read (it was nobody's, or it just
 *   loaded): nothing cached belongs to a previous context — kept, announced
 *   to the other tabs.
 *
 * Another tab's announcement (the session bus, below) only acts when this
 * tab has read `me` at least once (the same reason a switched tab resets
 * before showing anything): with nothing read, its own first read answers
 * under the shared new cookie. And it acts by asking, not by obeying: the
 * announcement is read back against the server, and what `me` answers above
 * decides — a stale, out-of-order or forged message changes nothing.
 */
function watchSession(
  queryClient: QueryClient,
  target: () => ErrorHandlerTarget | undefined,
) {
  const watch = sessionWatch(queryClient);
  // Another tab's announcement is a hint of a re-issued cookie, never a
  // decision: it may be stale (a sign out that another tab undid by signing
  // back in), delivered among others, or forged outright — BroadcastChannel
  // takes a script of this origin, and a compromised page can say anything.
  // So the cookie is read back, and the `me` watcher above compares what the
  // SERVER answers: nothing irreversible (a reset, a sign-out) happens on a
  // message's word alone, and a message that matches the session costs one
  // read and no more.
  watch.offBus = onSessionIdentity((identity) => {
    if (
      watch.applying ||
      identity === watch.identity ||
      // Nothing read yet under this client: no context of this tab's to
      // forget (the guard keeps an app's several clients — tests render
      // more than one — from reapplying the same change to each other).
      queryClient.getQueryData(meQuery.queryKey) === undefined
    ) {
      return;
    }
    // A forced refetch (`me` would answer the cache while fresh): a network
    // failure ends nothing — the next refetch, or a 401, says.
    void queryClient
      .fetchQuery({ ...meQuery, staleTime: 0 })
      .catch((error) =>
        console.warn('an announced session change could not be re-read', error),
      );
  });
  const meHash = JSON.stringify(meQuery.queryKey);
  queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash !== meHash) {
      return;
    }
    if (event.type === 'removed') {
      watch.identity = null;
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success') {
      return;
    }
    const next = sessionIdentity(event.action.data);
    if (watch.applying || next === watch.identity) {
      return;
    }
    if (watch.identity === null) {
      // The first `me` read here (just opened, or nobody was signed in and
      // the refetch says the session is somebody's now): no previous
      // context under the cache to forget.
      watch.identity = next;
      announceSessionIdentity(next);
      return;
    }
    if (next === null) {
      // Not what the app set itself (sign-out and endSession: setQueryData,
      // whose `clear` records the null and announces): a refetch found the
      // session over without a 401 anyone else saw.
      endSession(queryClient, target());
      return;
    }
    // Whoever switched (this tab's flow announced and is applying, or
    // another tab announced and this refetch confirms): forget the previous
    // context's data and mutations now, before anything of it is shown or
    // submitted again.
    void createSession(queryClient)
      .reset()
      .catch((error) =>
        console.warn('the session identity change could not be re-read', error),
      );
  });
}

/** A problem's field errors that no field took, by applyFieldErrors. */
const unplaced = new WeakMap<object, string[]>();

/**
 * A `validation_failed` (or any problem with `errors`) shown on the form's
 * fields: each `errors[].path` gets its message on a field, as a submit
 * error (TanStack Form clears it when the field changes), and the focus goes
 * to the first one (lib/form-focus.ts). The field is the path's alias
 * (`aliases`: path → field of another name), the path itself, else the
 * alias or field of its first segment: the API's paths are dotted
 * (`recipients.1`, `permissions.0.key`).
 *
 * Returns whether every error took a field. Otherwise the caller's
 * form-level alert says the rest: `errorMessage(error)` then gives the
 * messages no field showed (with their paths), not the generic `detail`.
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
  const fieldOf = (path: string) => {
    const first = path.split('.')[0] ?? '';
    return [aliases[path], path, aliases[first], first].find(
      (name) => name !== undefined && fields.has(name),
    );
  };
  const rest: string[] = [];
  for (const fieldError of error.errors) {
    const name = fieldOf(fieldError.path);
    if (name === undefined) {
      rest.push(
        fieldError.path
          ? `${fieldError.path}: ${fieldError.message}`
          : fieldError.message,
      );
      continue;
    }
    form.setFieldMeta(name, (meta) => ({
      ...meta,
      isTouched: true,
      errorMap: {
        ...meta?.errorMap,
        onSubmit: { message: fieldError.message },
      },
    }));
  }
  if (rest.length < error.errors.length) {
    focusFirstInvalid(form);
  }
  if (rest.length > 0) {
    unplaced.set(error, rest);
  }
  return rest.length === 0;
}
