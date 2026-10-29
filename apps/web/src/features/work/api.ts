import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useRealtimeEvent } from '@/lib/realtime';

/** What waits on the person (docs/work-surfaces.md): `GET /v1/inbox`. */
export type WorkItem = GetResponse<'/v1/inbox'>['items'][number];

export const workQuery = infiniteQueryOptions({
  queryKey: ['work', 'inbox'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({ pageParam }) =>
    unwrap(
      api.GET('/v1/inbox', {
        params: {
          query: { limit: 20, ...(pageParam && { cursor: pageParam }) },
        },
      }),
    ),
  getNextPageParam: (last) => last.nextCursor ?? undefined,
});

/** Dismisses an item that can be dismissed (a mention is marked read). */
export function useDismissWork() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      unwrap(api.POST('/v1/inbox/dismiss', { body: { key } })),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: workQuery.queryKey }),
  });
}

/** The person's recently opened records, newest first (GET /v1/recents). */
export const recentsQuery = queryOptions({
  queryKey: ['work', 'recents'],
  queryFn: () => unwrap(api.GET('/v1/recents')),
});

export function useClearRecents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/recents')),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: recentsQuery.queryKey }),
  });
}

/**
 * Notes that the person opened a record, once when its page shows (the
 * title only, never field content). Best effort: a failure is ignored (a
 * subject whose records can't be watched has no recents).
 */
export function useRecordRecent(record: {
  subject: string;
  recordId: string;
  label: string;
}) {
  const queryClient = useQueryClient();
  const { subject, recordId, label } = record;
  useEffect(() => {
    void api
      .POST('/v1/recents', { body: { subject, recordId, label } })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: recentsQuery.queryKey }),
      )
      .catch(() => undefined);
  }, [queryClient, subject, recordId, label]);
}

/** Beats this often while the page is open; the API forgets a person after 45 seconds. */
export const PRESENCE_BEAT_MS = 15_000;

export const presenceQuery = (subject: string, recordId: string) =>
  queryOptions({
    queryKey: ['work', 'presence', subject, recordId],
    queryFn: () =>
      unwrap(
        api.GET('/v1/presence/{subject}/{recordId}', {
          params: { path: { subject, recordId } },
        }),
      ),
  });

/**
 * Says the person is viewing or editing the record while the page is open
 * (a beat every PRESENCE_BEAT_MS, leaving on unmount) and returns the others
 * there. The list refetches when `record.presence` arrives for the record.
 * Advisory: the ETag still guards saving.
 */
export function usePresence(
  subject: string,
  recordId: string,
  mode: 'viewing' | 'editing',
) {
  const queryClient = useQueryClient();
  const query = presenceQuery(subject, recordId);
  useEffect(() => {
    const beat = () =>
      api
        .PUT('/v1/presence/{subject}/{recordId}', {
          params: { path: { subject, recordId } },
          body: { mode },
        })
        .then((result) => {
          if (result.data) {
            queryClient.setQueryData(query.queryKey, result.data);
          }
        })
        .catch(() => undefined);
    void beat();
    const timer = setInterval(() => void beat(), PRESENCE_BEAT_MS);
    return () => {
      clearInterval(timer);
      void api
        .DELETE('/v1/presence/{subject}/{recordId}', {
          params: { path: { subject, recordId } },
        })
        .catch(() => undefined);
    };
  }, [queryClient, query.queryKey, subject, recordId, mode]);
  useRealtimeEvent('record.presence', (event) => {
    if (event.subject === subject && event.recordId === recordId) {
      void queryClient.invalidateQueries({ queryKey: query.queryKey });
    }
  });
  const others = useQuery({ ...query, staleTime: PRESENCE_BEAT_MS });
  return others.data?.items.filter((person) => !person.self) ?? [];
}
