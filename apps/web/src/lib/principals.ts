import {
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
 * manageClients, readAudit). Anyone else gets 403: the pickers then say so.
 * Naming keys and ids on a page is not this route's job: it is
 * lib/people.ts's, open to every member.
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
