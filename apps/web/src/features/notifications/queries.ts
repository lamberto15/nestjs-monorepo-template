import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  unwrap,
  type GetResponse,
  type NotificationItem,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';

export type NotificationPage = GetResponse<'/v1/notifications'>;
export type NotificationType =
  GetResponse<'/v1/notifications/types'>['items'][number];
export type Preferences = GetResponse<'/v1/notifications/preferences'>['types'];

/** Every notifications query starts with this key (one invalidation covers all). */
const root = ['notifications'] as const;

/** The badge: `GET /v1/notifications/unread-count`. */
export const unreadKey = [...root, 'unread'] as const;

export const unreadQuery = (poll: number | false) =>
  queryOptions({
    queryKey: unreadKey,
    queryFn: () => unwrap(api.GET('/v1/notifications/unread-count')),
    // The live event keeps it current; without realtime, ask again.
    refetchInterval: poll,
  });

/** The bell's popover: the latest few. */
export const latestQuery = queryOptions({
  queryKey: [...root, 'latest'],
  queryFn: () =>
    unwrap(api.GET('/v1/notifications', { params: { query: { limit: 8 } } })),
});

/** The notification the API sends when a sign-in's password is in a known data breach. */
export const breachedType = 'security.passwordBreached';

/**
 * The unread breached-password alerts (the API has no `/me` flag for them).
 * Under the `list` key, so the live event and every mutation that refreshes
 * the lists refreshes this one too; the cached items it holds are rewritten
 * by `markCachedRead`, so read-ness is derived from the items, not the fetch.
 */
export const breachAlertQuery = queryOptions({
  queryKey: [...root, 'list', 'breach-alert'],
  staleTime: 60_000,
  queryFn: () =>
    unwrap(
      api.GET('/v1/notifications', {
        params: {
          query: { limit: 20, read: 'false', type: breachedType },
        },
      }),
    ),
});

/**
 * The dashboard's card: the latest unread notifications. Under the `list`
 * key like the breach alert's, so the live events and every mark-read update
 * it; the card shows the items still unread.
 */
export const unreadPreviewQuery = queryOptions({
  queryKey: [...root, 'list', 'dashboard'],
  staleTime: 60_000,
  queryFn: () =>
    unwrap(
      api.GET('/v1/notifications', {
        params: { query: { limit: 5, read: 'false' } },
      }),
    ),
  // A hint on the home page: a failure is not worth a toast.
  meta: { errorToast: false },
});

export type InboxFilter = { read?: 'true' | 'false'; type?: string };

/** The inbox: cursor pages, newest first (`nextCursor` null: the end). */
export const inboxQuery = (filter: InboxFilter, poll: number | false) =>
  infiniteQueryOptions({
    queryKey: [...root, 'list', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/v1/notifications', {
          params: {
            query: {
              limit: 20,
              ...(pageParam && { cursor: pageParam }),
              ...(filter.read && { read: filter.read }),
              ...(filter.type && { type: filter.type }),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: poll,
  });

export const typesQuery = queryOptions({
  queryKey: [...root, 'types'],
  queryFn: () => unwrap(api.GET('/v1/notifications/types')),
  staleTime: 5 * 60_000,
});

export const preferencesQuery = queryOptions({
  queryKey: [...root, 'preferences'],
  queryFn: () => unwrap(api.GET('/v1/notifications/preferences')),
});

type Items = NotificationItem[];
type Cached = NotificationPage | InfiniteData<NotificationPage>;

function isCachedPage(data: unknown): data is Cached {
  return (
    typeof data === 'object' &&
    data !== null &&
    ('items' in data || 'pages' in data)
  );
}

/**
 * Rewrites the items of every cached list (the bell's and the inbox's pages)
 * with `change`: how a mutation or a live event shows at once, before the
 * refetch that follows brings the server's truth.
 */
export function changeItems(
  queryClient: QueryClient,
  change: (items: Items) => Items,
) {
  queryClient.setQueriesData<Cached>(
    { queryKey: root, predicate: (query) => isCachedPage(query.state.data) },
    (data) => {
      if (!data) {
        return data;
      }
      if ('pages' in data) {
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: change(page.items),
          })),
        };
      }
      return { ...data, items: change(data.items) };
    },
  );
}

/** Marks cached items read; `before` limits it to those created before it. */
export function markCachedRead(
  queryClient: QueryClient,
  match: (item: NotificationItem) => boolean,
  readAt: string | null = new Date().toISOString(),
) {
  changeItems(queryClient, (items) =>
    items.map((item) =>
      match(item) && !item.read ? { ...item, read: true, readAt } : item,
    ),
  );
}

export function removeCached(queryClient: QueryClient, id: string) {
  changeItems(queryClient, (items) => items.filter((item) => item.id !== id));
}

/** A new notification: on top of the bell's list immediately. */
export function addCached(queryClient: QueryClient, item: NotificationItem) {
  // A collapsed notification replaces the older one of its key (a new id).
  queryClient.setQueryData<NotificationPage>(latestQuery.queryKey, (page) =>
    page
      ? {
          ...page,
          items: [
            item,
            ...page.items.filter(
              (old) =>
                old.id !== item.id && (!item.key || old.key !== item.key),
            ),
          ].slice(0, 8),
        }
      : page,
  );
}

/** Refresh active filtered lists after a batch of socket events. */
export function refreshNotificationLists(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: [...root, 'list'] });
}

export function setUnread(
  queryClient: QueryClient,
  unread: number,
  unreadCapped: boolean,
) {
  queryClient.setQueryData(unreadKey, { unread, unreadCapped });
}

/** Refetch what the cache can't know: the count, the filtered lists. */
export function refreshNotifications(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: unreadKey }),
    queryClient.invalidateQueries({ queryKey: [...root, 'list'] }),
  ]);
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.POST('/v1/notifications/{id}/read', {
        params: { path: { id } },
      });
    },
    onSuccess: async (_data, id) => {
      markCachedRead(queryClient, (item) => item.id === id);
      await refreshNotifications(queryClient);
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      // What the client has shown: later arrivals stay unread.
      const before = new Date().toISOString();
      return unwrap(
        api.POST('/v1/notifications/read-all', { body: { before } }),
      ).then(() => before);
    },
    onSuccess: async (before) => {
      markCachedRead(queryClient, (item) => item.createdAt < before);
      await refreshNotifications(queryClient);
    },
  });
}

export function useRemoveNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.DELETE('/v1/notifications/{id}', { params: { path: { id } } });
    },
    onSuccess: async (_data, id) => {
      removeCached(queryClient, id);
      await refreshNotifications(queryClient);
    },
  });
}
