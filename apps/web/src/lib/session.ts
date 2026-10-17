import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  isApiError,
  unwrap,
  type GetResponse,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';

export type Me = GetResponse<'/v1/auth/me'>;
export type Methods = GetResponse<'/v1/auth/methods'>;
export type Features = GetResponse<'/v1/features'>;
export type Tenant = GetResponse<'/v1/auth/tenants'>['items'][number];

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
     * else): nothing cached belongs to it, so everything is dropped.
     */
    reset: async () => {
      queryClient.removeQueries();
      await queryClient.fetchQuery(meQuery);
    },
    /** Signed out (or the session ended): forget the user and their data. */
    clear: () => {
      // The sign-in options are public: the only thing worth keeping.
      queryClient.removeQueries({
        predicate: (query) => query.queryHash !== methodsHash,
      });
      queryClient.setQueryData(meQuery.queryKey, null);
    },
  };
}
