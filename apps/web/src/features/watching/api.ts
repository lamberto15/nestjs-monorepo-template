import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useMutationState,
  useQueryClient,
} from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * What the caller watches (docs/notifications.md, "Watching records"):
 * `GET /v1/subscriptions` and `DELETE /v1/subscriptions/{subject}/{recordId}`.
 * The record's own `POST`/`DELETE …/{id}/watch` is the feature's route, called
 * by `components/records/watch-button.tsx` (it shares these keys).
 */
export type Subscription = GetResponse<'/v1/subscriptions'>['items'][number];

const root = ['watching'] as const;

/** Whether one record is watched: the list filtered to it (the record carries no flag). */
export const watchedKey = (subject: string, recordId: string) =>
  [...root, 'record', subject, recordId] as const;

export const watchedQuery = (subject: string, recordId: string) =>
  queryOptions({
    queryKey: watchedKey(subject, recordId),
    queryFn: async () => {
      const page = await unwrap(
        api.GET('/v1/subscriptions', {
          params: { query: { subject, recordId, limit: 1 } },
        }),
      );
      return page.items.length > 0;
    },
  });

/** Everything the caller watches, newest first, cursor pages. */
export const subscriptionsQuery = infiniteQueryOptions({
  queryKey: [...root, 'list'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/v1/subscriptions', {
        params: {
          query: { limit: 20, ...(pageParam && { cursor: pageParam }) },
        },
      }),
    ),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
});

export const stopKey = [...root, 'stop'] as const;

type Stopped = Pick<Subscription, 'subject' | 'recordId'>;

/** Stops watching a record from the list (the subject's route is not needed). */
export function useStopWatching() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('watching');
  return useMutation({
    mutationKey: stopKey,
    mutationFn: (item: Stopped) =>
      unwrap(
        api.DELETE('/v1/subscriptions/{subject}/{recordId}', {
          params: { path: { subject: item.subject, recordId: item.recordId } },
        }),
      ),
    onSuccess: (_data, item) => {
      queryClient.setQueryData(watchedKey(item.subject, item.recordId), false);
      toast.success(t('stopped'));
    },
    // Also after a failure (a 404: it was not watched after all): the list
    // shows what is true.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: [...root, 'list'] }),
  });
}

/** The rows being stopped now, as `subject/recordId`: one mutation per row may be in flight. */
export function useStoppingRows(): Set<string> {
  const pending = useMutationState({
    filters: { mutationKey: stopKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as Stopped,
  });
  return new Set(pending.map((v) => `${v.subject}/${v.recordId}`));
}
