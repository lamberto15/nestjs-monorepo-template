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
import { recordKeys } from '@/lib/records';

const endpoints = '/v1/access/clients/{clientId}/webhook-endpoints';
const endpoint = '/v1/access/clients/{clientId}/webhook-endpoints/{id}';
export const deliveriesPath =
  '/v1/access/clients/{clientId}/webhook-deliveries';

export type Endpoint = GetResponse<typeof endpoints>['items'][number];
export type Delivery = GetResponse<typeof deliveriesPath>['items'][number];
export type DeliveryStatus = Delivery['status'];

type JsonBody<T> = T extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

export type CreateEndpointBody = JsonBody<paths[typeof endpoints]['post']>;
export type EndpointChanges = JsonBody<paths[typeof endpoint]['patch']>;

/** Everything of one client's webhooks starts with this key. */
export const webhooksKey = (clientId: string) =>
  ['webhooks', clientId] as const;

/** What can be subscribed to, by feature (`GET /v1/webhook-event-types`). */
export const eventTypesQuery = queryOptions({
  queryKey: ['webhooks', 'event-types'],
  queryFn: () => unwrap(api.GET('/v1/webhook-event-types')),
  staleTime: 10 * 60 * 1000,
});

export const endpointsQuery = (clientId: string) =>
  queryOptions({
    queryKey: [...webhooksKey(clientId), 'endpoints'],
    queryFn: () =>
      unwrap(api.GET(endpoints, { params: { path: { clientId } } })),
  });

/** One endpoint, never its secret (404: none such). */
export const endpointQuery = (clientId: string, id: string) =>
  queryOptions({
    queryKey: [...webhooksKey(clientId), 'endpoint', id],
    queryFn: () =>
      unwrap(api.GET(endpoint, { params: { path: { clientId, id } } })),
  });

/** One delivery with the payload sent and every attempt's response. */
export const deliveryQuery = (clientId: string, id: string) =>
  queryOptions({
    queryKey: [...webhooksKey(clientId), 'delivery', id],
    queryFn: () =>
      unwrap(
        api.GET(`${deliveriesPath}/{id}`, {
          params: { path: { clientId, id } },
        }),
      ),
  });

function useRefresh(clientId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: webhooksKey(clientId) }),
      // The deliveries are a ListPage: its pages are under the list's path.
      queryClient.invalidateQueries({
        queryKey: recordKeys.lists(deliveriesPath),
      }),
    ]);
}

/**
 * Creating returns the secret, this once. `gcTime: 0` drops the result from
 * the mutation cache as soon as nothing observes it, and the dialog that
 * shows it calls `reset()` on close: the secret is in no cache afterwards.
 * The refetched list never carries one.
 */
export function useCreateEndpoint(clientId: string) {
  const refresh = useRefresh(clientId);
  return useMutation({
    gcTime: 0,
    meta: { errorToast: false },
    mutationFn: (body: CreateEndpointBody) =>
      unwrap(api.POST(endpoints, { params: { path: { clientId } }, body })),
    onSettled: refresh,
  });
}

export function useUpdateEndpoint(clientId: string, id: string) {
  const refresh = useRefresh(clientId);
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: EndpointChanges) =>
      unwrap(api.PATCH(endpoint, { params: { path: { clientId, id } }, body })),
    onSuccess: refresh,
  });
}

/** A new secret (shown once, as in {@link useCreateEndpoint}). */
export function useRotateSecret(clientId: string, id: string) {
  return useMutation({
    gcTime: 0,
    mutationFn: () =>
      unwrap(
        api.POST(`${endpoint}/rotate-secret`, {
          params: { path: { clientId, id } },
        }),
      ),
  });
}

export function useDeleteEndpoint(clientId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await unwrap(
        api.DELETE(endpoint, { params: { path: { clientId, id } } }),
      );
    },
    onSuccess: async () => {
      // Its own queries would 404 on a refetch: dropped, then the rest.
      queryClient.removeQueries({
        queryKey: endpointQuery(clientId, id).queryKey,
      });
      await queryClient.invalidateQueries({ queryKey: webhooksKey(clientId) });
    },
  });
}

/** A test event to this endpoint alone: answers the delivery it made. */
export function useSendTest(clientId: string, id: string) {
  const refresh = useRefresh(clientId);
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST(`${endpoint}/test`, { params: { path: { clientId, id } } }),
      ),
    onSuccess: refresh,
  });
}

export function useRetryDelivery(clientId: string) {
  const refresh = useRefresh(clientId);
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST(`${deliveriesPath}/{id}/retry`, {
          params: { path: { clientId, id } },
        }),
      ),
    onSuccess: refresh,
  });
}

/** Every failed delivery of the endpoint, since a time if given. */
export function useRetryFailed(clientId: string, endpointId: string) {
  const refresh = useRefresh(clientId);
  return useMutation({
    mutationFn: (since: string | undefined) =>
      unwrap(
        api.POST(`${deliveriesPath}/retry`, {
          params: { path: { clientId } },
          body: { endpointId, ...(since && { since }) },
        }),
      ),
    onSuccess: refresh,
  });
}

/** The JSON of a payload as indented text; anything else as it is. */
export function prettyPayload(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Epoch milliseconds as the ISO string the formatters take. */
export function fromMs(value: number | null | undefined): string | null {
  return value === null || value === undefined
    ? null
    : new Date(value).toISOString();
}
