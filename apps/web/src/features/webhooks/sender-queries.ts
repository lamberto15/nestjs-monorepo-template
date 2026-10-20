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

const senders = '/v1/webhook-senders';
const sender = '/v1/webhook-senders/{id}';

export type Sender = GetResponse<typeof senders>['items'][number];

type JsonBody<T> = T extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

export type CreateSenderBody = JsonBody<paths[typeof senders]['post']>;
export type SenderChanges = JsonBody<paths[typeof sender]['patch']>;

export const sendersKey = ['webhook-senders'] as const;

export const sendersQuery = queryOptions({
  queryKey: sendersKey,
  queryFn: () => unwrap(api.GET(senders)),
});

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: sendersKey });
}

/**
 * Creating returns the secret, this once. `gcTime: 0` drops the result from
 * the mutation cache once nothing observes it, and the dialog that shows it
 * calls `reset()` on close: the secret is in no cache afterwards.
 */
export function useCreateSender() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    meta: { errorToast: false },
    mutationFn: (body: CreateSenderBody) => unwrap(api.POST(senders, { body })),
    onSettled: refresh,
  });
}

export function useUpdateSender() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (args: { id: string; changes: SenderChanges }) =>
      unwrap(
        api.PATCH(sender, {
          params: { path: { id: args.id } },
          body: args.changes,
        }),
      ),
    onSuccess: refresh,
  });
}

/** A new secret (shown once, as in {@link useCreateSender}). */
export function useRotateSenderSecret() {
  const refresh = useRefresh();
  return useMutation({
    gcTime: 0,
    mutationFn: (id: string) =>
      unwrap(
        api.POST(`${sender}/rotate-secret`, {
          params: { path: { id } },
          body: {},
        }),
      ),
    // The list shows when the old secret stops verifying.
    onSuccess: refresh,
  });
}

export function useDeleteSender() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (id: string) => {
      await unwrap(api.DELETE(sender, { params: { path: { id } } }));
    },
    onSuccess: refresh,
  });
}
