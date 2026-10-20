import { unwrap } from '@nestjs-monorepo-template/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  NamingSeriesChanges,
  NamingSeriesCreate,
} from '@/lib/naming-series';

/**
 * A series changed: the admin lists and the create forms' pickers
 * (`['naming-series', …]`) are read again. A new record's number comes from
 * the series, so the numbers the lists show are not stale by this.
 */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['naming-series'] });
}

// The dialogs show the refusals (a pattern the subject has is a 409, a bad
// one a 400 with field errors): the global handler stays quiet for them.
export function useCreateSeries() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: NamingSeriesCreate) =>
      unwrap(api.POST('/v1/naming-series', { body })),
    onSuccess: refresh,
  });
}

export function useUpdateSeries() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { id: string; changes: NamingSeriesChanges }) =>
      unwrap(
        api.PATCH('/v1/naming-series/{id}', {
          params: { path: { id: input.id } },
          body: input.changes,
        }),
      ),
    onSuccess: refresh,
  });
}

export function useDeleteSeries() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE('/v1/naming-series/{id}', { params: { path: { id } } }),
      ),
    onSuccess: refresh,
  });
}

export function useSetCounter() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { id: string; current: number }) =>
      unwrap(
        api.PUT('/v1/naming-series/{id}/counter', {
          params: { path: { id: input.id } },
          body: { current: input.current },
        }),
      ),
    onSuccess: refresh,
  });
}

/** What a pattern would give next: the dialog's live preview. */
export function previewQuery(subject: string, pattern: string) {
  return {
    queryKey: ['naming-series', 'preview', subject, pattern],
    queryFn: () =>
      unwrap(
        api.GET('/v1/naming-series/preview', {
          params: { query: { subject, pattern } },
        }),
      ),
    meta: { errorToast: false },
    retry: false,
  } as const;
}

export function counterQuery(id: string) {
  return {
    queryKey: ['naming-series', 'counter', id],
    queryFn: () =>
      unwrap(
        api.GET('/v1/naming-series/{id}/counter', {
          params: { path: { id } },
        }),
      ),
    meta: { errorToast: false },
    gcTime: 0,
  } as const;
}
