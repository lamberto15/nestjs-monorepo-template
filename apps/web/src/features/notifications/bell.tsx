import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@nestjs-monorepo-template/ui/components/popover';
import { BellIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotificationRow } from './notification-item';
import {
  latestQuery,
  unreadQuery,
  useMarkAllRead,
  useMarkRead,
} from './queries';
import { useLiveNotifications } from './use-live-notifications';
import { useNotificationAccess } from './use-notification-access';

/**
 * The header's bell: the unread count (live from the socket), and a popover
 * with the latest notifications. Shown only when `realtime` is on; without
 * it the inbox page polls instead.
 */
export function NotificationsBell() {
  const { realtime } = useNotificationAccess();
  if (!realtime) {
    return null;
  }
  return <Bell />;
}

function Bell() {
  const { t } = useTranslation('notifications');
  const { canChange } = useNotificationAccess();
  const [open, setOpen] = useState(false);
  useLiveNotifications();
  const unread = useQuery(unreadQuery(false)).data?.unread ?? 0;
  const latest = useQuery({ ...latestQuery, enabled: open });
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const items = latest.data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={t('bell.label', { count: unread })}
          />
        }
      >
        <BellIcon />
        {unread > 0 && (
          <Badge
            aria-hidden
            className="absolute -end-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 text-[10px]"
          >
            {unread > 99 ? '99+' : unread}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b p-3">
          <span className="text-sm font-medium">{t('bell.title')}</span>
          {canChange && unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              {t('markAllRead')}
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {latest.isPending ? t('loading') : t('bell.empty')}
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                onRead={canChange ? (id) => markRead.mutate(id) : undefined}
                onOpen={() => setOpen(false)}
              />
            ))}
          </ul>
        )}
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            render={<Link to="/notifications" onClick={() => setOpen(false)} />}
          >
            {t('bell.viewAll')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
