import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { api } from '@/lib/api';

export type Favorite = GetResponse<'/v1/favorites'>['items'][number];
export type NewFavorite = paths['/v1/favorites']['post'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/** The signed-in person's favorites, in their order (GET /v1/favorites). */
export const favoritesQuery = queryOptions({
  queryKey: ['favorites'],
  queryFn: () => unwrap(api.GET('/v1/favorites')),
});

/** The favorite of this target, if it is one (the list from `favoritesQuery`). */
export function findFavorite(
  favorites: readonly Favorite[] | undefined,
  target: Pick<NewFavorite, 'kind' | 'subject' | 'target'>,
) {
  return favorites?.find(
    (favorite) =>
      favorite.kind === target.kind &&
      favorite.subject === (target.subject ?? '') &&
      favorite.target === target.target,
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: favoritesQuery.queryKey });
}

export function useAddFavorite() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: NewFavorite) =>
      unwrap(api.POST('/v1/favorites', { body })),
    onSettled: refresh,
  });
}

export function useRemoveFavorite() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/v1/favorites/{id}', { params: { path: { id } } })),
    onSettled: refresh,
  });
}

/** Puts every favorite in the new order; the cache shows it at once. */
export function useReorderFavorites() {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (items: Favorite[]) =>
      unwrap(
        api.PUT('/v1/favorites/order', {
          body: { ids: items.map((item) => item.id) },
        }),
      ),
    onMutate: (items) => {
      queryClient.setQueryData(favoritesQuery.queryKey, { items });
    },
    onSettled: refresh,
  });
}

/**
 * The page's path, for a favorite of it: the router's (its history may be
 * memory, not the window's), or the window's where no router is mounted.
 */
export function useCurrentPath() {
  const router = useRouter({ warn: false });
  return router?.state.location.pathname ?? window.location.pathname;
}
