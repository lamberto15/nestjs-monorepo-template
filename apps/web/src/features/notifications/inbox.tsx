import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotificationRow } from './notification-item';
import {
  inboxQuery,
  typesQuery,
  unreadQuery,
  useMarkAllRead,
  useMarkRead,
  useRemoveNotification,
  type InboxFilter,
} from './queries';
import { useNotificationAccess } from './use-notification-access';

const any = 'all';

/** `/notifications`: every notification, filtered, a page at a time. */
export function Inbox() {
  const { t } = useTranslation('notifications');
  const { poll, canChange } = useNotificationAccess();
  const [read, setRead] = useState<string>(any);
  const [type, setType] = useState<string>(any);
  const filter: InboxFilter = {
    ...(read !== any && { read: read as 'true' | 'false' }),
    ...(type !== any && { type }),
  };
  const list = useInfiniteQuery(inboxQuery(filter, poll));
  const unread = useQuery(unreadQuery(poll)).data?.unread ?? 0;
  const types = useQuery(typesQuery).data?.items ?? [];
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const remove = useRemoveNotification();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  const readItems = [
    { value: any, label: t('inbox.filters.all') },
    { value: 'false', label: t('inbox.filters.unread') },
    { value: 'true', label: t('inbox.filters.read') },
  ];
  const typeItems = [
    { value: any, label: t('inbox.filters.anyType') },
    ...types.map((entry) => ({ value: entry.type, label: entry.label })),
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-medium">{t('inbox.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('inbox.unread', { count: unread })}
          </p>
        </div>
        {canChange && (
          <Button
            variant="outline"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            {markAll.isPending && <Spinner />}
            {t('markAllRead')}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Select
          items={readItems}
          value={read}
          onValueChange={(value) => setRead(value ?? any)}
        >
          <SelectTrigger aria-label={t('inbox.filters.status')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {readItems.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={typeItems}
          value={type}
          onValueChange={(value) => setType(value ?? any)}
        >
          <SelectTrigger aria-label={t('inbox.filters.type')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typeItems.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {list.isPending ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {t('inbox.empty')}
        </p>
      ) : (
        <ul className="rounded-lg border">
          {items.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              onRead={canChange ? (id) => markRead.mutate(id) : undefined}
              onRemove={canChange ? (id) => remove.mutate(id) : undefined}
            />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage && <Spinner />}
          {t('inbox.loadMore')}
        </Button>
      )}
    </div>
  );
}
