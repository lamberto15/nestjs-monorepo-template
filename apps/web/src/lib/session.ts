import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  isApiError,
  unwrap,
  type GetResponse,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import { announceSessionIdentity } from '@/lib/session-bus';

export type Me = GetResponse<'/v1/auth/me'>;
export type Methods = GetResponse<'/v1/auth/methods'>;
export type Features = GetResponse<'/v1/features'>;

/**
 * Who is signed in: null when nobody is (401). The browser's session is the
 * httpOnly `__Host-sid` cookie, so asking the API is the only way to know.
 */
export const meQuery = queryOptions({
  queryKey: ['auth', 'me'],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await unwrap(api.GET('/v1/auth/me'));
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        return null;
      }
      throw error;
    }
  },
  staleTime: 60_000,
  retry: false,
});

/**
 * The session's identity: who is signed in, in which tenant, acting as whom —
 * null when nobody is. A refetch of `me` that answers with a different one
 * means the cookie was re-issued for another context (a sign-in, `POST
 * /v1/auth/tenant`, an impersonation started or stopped), and nothing cached
 * belongs to it any more (the session watcher, lib/errors.ts). Realtime's
 * socket keys the same three parts plus `authenticatedAt` (`connectionKey`,
 * lib/realtime.tsx): it reopens per re-issued cookie, whatever the identity;
 * the session's part in those three alone decides the cached data's context.
 */
export function sessionIdentity(me: Me | null | undefined): string | null {
  if (!me) {
    return null;
  }
  return [me.user.id, me.tenant?.id ?? '', me.user.impersonator?.id ?? ''].join(
    '|',
  );
}

/**
 * What the session watcher (lib/errors.ts) and the flows below know about
 * one query client's session: the identity of the `me` answer it saw last
 * (null: nobody, or not yet read at all — both have no context to forget)
 * and, while `applying`, that one of the flows here is resetting or clearing
 * the cache and announces the identity itself, so the watcher does not
 * reapply it from the `me` event that the flow's own refetch answers.
 */
export type SessionWatch = {
  identity: string | null;
  applying: boolean;
};

const watching = new WeakMap<QueryClient, SessionWatch>();

export function sessionWatch(queryClient: QueryClient): SessionWatch {
  let watch = watching.get(queryClient);
  if (!watch) {
    watch = { identity: null, applying: false };
    watching.set(queryClient, watch);
  }
  return watch;
}

/** The sign-in options (public): drives the sign-in page. */
export const methodsQuery = queryOptions({
  queryKey: ['auth', 'methods'],
  queryFn: () => unwrap(api.GET('/v1/auth/methods')),
  staleTime: 5 * 60_000,
});

/** The deployment's switches (signed in only). */
export const featuresQuery = queryOptions({
  queryKey: ['features'],
  queryFn: () => unwrap(api.GET('/v1/features')),
  staleTime: 5 * 60_000,
});

/** Saving the menu's language (PATCH /v1/auth/me): see useSavedLanguage. */
export const saveLanguageKey = ['auth', 'language'] as const;

export const tenantsQuery = queryOptions({
  queryKey: ['auth', 'tenants'],
  queryFn: () => unwrap(api.GET('/v1/auth/tenants')),
});

const methodsHash = JSON.stringify(methodsQuery.queryKey);

/** The router context's `session`: the session, through the query cache. */
export type Session = ReturnType<typeof createSession>;

export function createSession(queryClient: QueryClient) {
  return {
    /** The signed-in user, fetched once and then cached (null: nobody). */
    me: () => queryClient.ensureQueryData(meQuery),
    /**
     * A new session (signed in, switched tenant, re-authenticated as someone
     * else): nothing cached belongs to it. `resetQueries` is TanStack Query's
     * documented tool for that: every query goes back to its initial state
     * (the old data is dropped) and, unlike `removeQueries`/`clear`, the
     * mounted observers are notified and the active queries refetch, so the
     * sidebar, the user menu and the current page show the new session. Call
     * it before navigating, so no old data is rendered after the switch.
     */
    reset: async () => {
      // Mutations too: their variables and results (a password change,
      // recovery codes, a TOTP secret) must not outlive the session.
      const watch = sessionWatch(queryClient);
      watch.applying = true;
      try {
        queryClient.getMutationCache().clear();
        await queryClient.resetQueries();
        // Not mounted anywhere (a sign-in page): fetch it, so the route
        // guards find the new user. Fresh after the reset's refetch otherwise.
        const me = await queryClient.fetchQuery(meQuery);
        watch.identity = sessionIdentity(me);
        // The browser's other tabs share the new cookie: with this they
        // forget the previous context now, not at their next refetch.
        announceSessionIdentity(watch.identity);
      } finally {
        watch.applying = false;
      }
    },
    /** Signed out (or the session ended): forget the user and their data. */
    clear: () => {
      // The sign-in options are public: the only thing worth keeping.
      const watch = sessionWatch(queryClient);
      watch.applying = true;
      try {
        queryClient.getMutationCache().clear();
        queryClient.removeQueries({
          predicate: (query) => query.queryHash !== methodsHash,
        });
        queryClient.setQueryData(meQuery.queryKey, null);
        watch.identity = null;
        // Other tabs now hold a session nobody does (a sign-out, an idle or
        // absolute limit): they end theirs at once, not at their next 401.
        announceSessionIdentity(null);
      } finally {
        watch.applying = false;
      }
    },
  };
}
