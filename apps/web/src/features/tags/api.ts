import { unwrap, type paths } from '@nestjs-monorepo-template/api-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A tag's name and description mirror the API's `maxLength`;
 * lib/limits.test.ts compares them with openapi.json.
 */
export const TAG_LIMITS = { name: 100, description: 500 } as const;

/** What a PATCH changes: only what is sent; `null` clears the color or the description. */
export type TagChanges = paths['/v1/tags/{id}']['patch'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/**
 * A tag's name, color or removal reaches everything that shows it: the tag
 * lists (the record pages' picker, the lists' tag filter: `['tags', …]`), and
 * the records that carry it, whose lists and details embed `tags` by name
 * (`['list', …]`, `['record', …]`).
 */
function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      (['tags', 'list', 'record'] as const).map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
}

// The dialog shows the refusals (a name another tag of the subject has is a
// 409 on the name field): the global handler stays quiet for it. The API's tag
// routes take no ETag (no If-Match, no 412): the last write wins.
export function useUpdateTag() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { id: string; changes: TagChanges }) =>
      unwrap(
        api.PATCH('/v1/tags/{id}', {
          params: { path: { id: input.id } },
          body: input.changes,
        }),
      ),
    onSuccess: refresh,
  });
}

/** Every record carrying the tag loses it (the API cascades the links). */
export function useDeleteTag() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/v1/tags/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });
}
