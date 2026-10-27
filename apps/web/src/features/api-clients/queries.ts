import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';

export type Client = GetResponse<'/v1/access/clients'>['items'][number];
export type Usage = GetResponse<'/v1/access/clients/{id}/usage'>;

/** Every API-clients query starts with this key (one invalidation covers all). */
export const clientsKey = ['api-clients'] as const;

export const clientsQuery = queryOptions({
  queryKey: [...clientsKey, 'list'],
  queryFn: () => unwrap(api.GET('/v1/access/clients')),
});

/** One client, never its keys' secrets (404: none such). */
export const clientQuery = (id: string) =>
  queryOptions({
    queryKey: [...clientsKey, 'one', id],
    queryFn: () =>
      unwrap(api.GET('/v1/access/clients/{id}', { params: { path: { id } } })),
  });

type JsonBody<T> = T extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/**
 * A client's name mirrors the API's `maxLength`; lib/limits.test.ts
 * compares it with openapi.json.
 */
export const API_CLIENT_LIMITS = { name: 80 } as const;

/** What a create sends: the name, its daily quota and roles, at once. */
export type CreateClientBody = JsonBody<paths['/v1/access/clients']['post']>;

/** What a PATCH changes: active, the quota, the roles and their ends. */
export type ClientChanges = JsonBody<paths['/v1/access/clients/{id}']['patch']>;

/** Per UTC day and route, `from` to `to` included (yyyy-mm-dd). */
export const usageQuery = (id: string, from: string, to: string) =>
  queryOptions({
    queryKey: [...clientsKey, 'usage', id, from, to],
    queryFn: () =>
      unwrap(
        api.GET('/v1/access/clients/{id}/usage', {
          params: { path: { id }, query: { from, to } },
        }),
      ),
  });

/** Whether the key's expiry has passed. */
export function isExpired(key: { expiresAt: string | null }, now = Date.now()) {
  return key.expiresAt !== null && Date.parse(key.expiresAt) <= now;
}

/** A key is active until revoked or expired. */
export function activeKeys(client: Client) {
  return client.keys.filter((key) => !key.revokedAt && !isExpired(key));
}

/** The latest `lastUsedAt` over a client's keys. */
export function lastUsed(client: Client): string | null {
  return (
    client.keys
      .map((key) => key.lastUsedAt)
      .filter((value): value is string => value !== null)
      .toSorted()
      .at(-1) ?? null
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: clientsKey });
}

/**
 * Creating returns the key, this once. `gcTime: 0` drops the result from
 * the mutation cache as soon as nothing observes it, and the dialog that
 * shows it calls `reset()` on close: the key is in no cache afterwards.
 * (The list is refetched; it never carries a key.)
 */
export function useCreateClient() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    meta: { errorToast: false },
    // The quota and roles go with the create, in its one transaction.
    mutationFn: (body: CreateClientBody) =>
      unwrap(api.POST('/v1/access/clients', { body })),
    onSettled: refresh,
  });
}

/** A new key (shown once, as in {@link useCreateClient}). */
export function useRotateKey(id: string) {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (graceSeconds: number) =>
      unwrap(
        api.POST('/v1/access/clients/{id}/rotate', {
          params: { path: { id } },
          body: { graceSeconds },
        }),
      ),
    onSettled: refresh,
  });
}

/** `errorToast: false`: the caller shows a refusal itself, on a field. */
export function useUpdateClient(
  id: string,
  options: { errorToast?: boolean } = {},
) {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: options.errorToast ?? true },
    mutationFn: (body: ClientChanges) =>
      unwrap(
        api.PATCH('/v1/access/clients/{id}', {
          params: { path: { id } },
          body,
        }),
      ),
    onSuccess: refresh,
  });
}

export function useRevokeKey(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (keyId: string) => {
      await api.DELETE('/v1/access/clients/{id}/keys/{keyId}', {
        params: { path: { id, keyId } },
      });
    },
    onSuccess: refresh,
  });
}

/**
 * Deletes the client for good (`DELETE /v1/access/clients/{id}`): its keys,
 * roles, usage and webhook endpoints go with it. Revoking keeps it.
 */
export function useDeleteClient(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await unwrap(
        api.DELETE('/v1/access/clients/{id}', { params: { path: { id } } }),
      );
    },
    onSuccess: async () => {
      // Its own query would 404 on a refetch: dropped, then the list.
      queryClient.removeQueries({ queryKey: clientQuery(id).queryKey });
      await queryClient.invalidateQueries({ queryKey: clientsKey });
    },
  });
}
