import { useQueryClient } from '@tanstack/react-query';
import { watchNotifications } from '@nestjs-monorepo-template/api-client';
import { useEffect } from 'react';
import { useRealtime } from '@/lib/realtime';
import {
  addCached,
  markCachedRead,
  removeCached,
  setUnread,
  unreadKey,
} from './queries';

/**
 * Keeps the notifications cache current from the socket (`watchNotifications`
 * of the typed client): the badge's number, the lists. Mounted once, by the
 * bell, which exists exactly when the socket does. A change made in another
 * tab or device arrives the same way as one made here.
 */
export function useLiveNotifications() {
  const realtime = useRealtime();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!realtime) {
      return;
    }
    return watchNotifications(realtime, {
      onUnread: (unread) => setUnread(queryClient, unread),
      onItem: (item) => addCached(queryClient, item),
      onRead: ({ id, readAt }) =>
        markCachedRead(queryClient, (item) => item.id === id, readAt),
      onReadAll: ({ before }) => {
        markCachedRead(
          queryClient,
          (item) => before === null || item.createdAt < before,
        );
        void queryClient.invalidateQueries({ queryKey: unreadKey });
      },
      onRemoved: (id) => removeCached(queryClient, id),
    });
  }, [realtime, queryClient]);
}
