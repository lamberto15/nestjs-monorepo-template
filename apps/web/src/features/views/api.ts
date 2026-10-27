import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type SavedView = GetResponse<'/v1/views'>['items'][number];
export type NewView = paths['/v1/views']['post'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;
export type ViewChanges = paths['/v1/views/{id}']['patch'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/** The most views the picker lists (a person has 100 private ones at most). */
const PICKER_LIMIT = 100;

/**
 * The views of a list the caller sees: theirs, their units' and the
 * tenant's. Read when the picker opens (`enabled`), by name; the picker
 * shows a failure itself.
 */
export function useViews(subject: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ['views', subject],
    meta: { errorToast: false },
    queryFn: () =>
      unwrap(
        api.GET('/v1/views', {
          params: {
            query: { subject, sort: 'name', limit: PICKER_LIMIT },
          },
        }),
      ),
  });
}

/**
 * A view checked again, as the list route's `params` and the visible
 * `columns` (docs/saved-views.md). The picker words the refusals (a stale
 * view is a 400, a forbidden field a 403): the global handler stays quiet.
 */
export function useApplyView() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (id: string) =>
      unwrap(api.GET('/v1/views/{id}/apply', { params: { path: { id } } })),
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['views'] });
}

// The dialogs show the refusals (a name taken is a 409 on the name field).
export function useCreateView() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: NewView) => unwrap(api.POST('/v1/views', { body })),
    onSuccess: refresh,
  });
}

export function useUpdateView() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { id: string; changes: ViewChanges }) =>
      unwrap(
        api.PATCH('/v1/views/{id}', {
          params: { path: { id: input.id } },
          body: input.changes,
        }),
      ),
    onSuccess: refresh,
  });
}

export function useDeleteView() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/v1/views/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });
}
