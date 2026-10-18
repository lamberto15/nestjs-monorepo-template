import {
  isApiError,
  unwrap,
  type GetQuery,
  type ItemOf,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The tenant's users and API clients as pickers show them,
 * `GET /v1/access/principals` (docs/permissions.md, "Picking users and API
 * clients"). Each one's `key` (`user:<id>`, `client:<id>`) is what a
 * setting's user scope takes as `scopeId`; `id` is the user's or client's.
 *
 * Who may call it: the callers who may list users or clients
 * (`AccessPolicy.open`: any of Access.manageRoles, manageUsers,
 * manageClients, readAudit). Anyone else gets 403: the pickers then say so
 * and the directory is empty (backend #119, #129: a people lookup open to
 * every member).
 */
export type Principal = ItemOf<'/v1/access/principals'>;
export type PrincipalKind = Principal['kind'];

type PrincipalQuery = GetQuery<'/v1/access/principals'>;

/** A principal's name for people: the label, and a user's address. */
export function principalLabel(principal: Principal): string {
  return principal.email && principal.email !== principal.label
    ? `${principal.label} (${principal.email})`
    : principal.label;
}

export const principalKeys = {
  all: ['principals'] as const,
  search: (query: PrincipalQuery) =>
    [...principalKeys.all, 'search', query] as const,
  directory: (kind?: PrincipalKind) =>
    [...principalKeys.all, 'directory', kind ?? 'any'] as const,
};

/** The first page matching `q` (left out when empty: the API wants 1+ characters). */
export function principalSearchQuery(input: {
  q: string;
  kind?: PrincipalKind;
  active?: boolean;
  limit?: number;
}) {
  const q = input.q.trim().slice(0, 200);
  const query: PrincipalQuery = {
    sort: 'label',
    limit: input.limit ?? 20,
    ...(q && { q }),
    ...(input.kind && { kind: input.kind }),
    ...(input.active && { active: 'true' as const }),
  };
  return queryOptions({
    queryKey: principalKeys.search(query),
    queryFn: async () =>
      (await unwrap(api.GET('/v1/access/principals', { params: { query } })))
        .items,
    staleTime: 30_000,
  });
}

/** The most a directory reads: far past what a page can show by name. */
const DIRECTORY_MAX = 1000;

/**
 * Every principal (of a kind), inactive ones too: to name the people a
 * page refers to by id or key (comment authors, a setting's overrides). A
 * caller without the right gets an empty directory, not an error.
 */
export function principalDirectoryQuery(kind?: PrincipalKind) {
  return queryOptions({
    queryKey: principalKeys.directory(kind),
    queryFn: async () => {
      const found: Principal[] = [];
      try {
        for await (const principal of api.items('/v1/access/principals', {
          sort: 'label',
          limit: 100,
          ...(kind && { kind }),
        })) {
          found.push(principal);
          if (found.length >= DIRECTORY_MAX) break;
        }
      } catch (error) {
        if (isApiError(error) && error.status === 403) {
          return [];
        }
        throw error;
      }
      return found;
    },
    // The directory changes rarely; a 403 is not worth asking again.
    staleTime: 5 * 60_000,
    retry: false,
    meta: { errorToast: false },
  });
}
