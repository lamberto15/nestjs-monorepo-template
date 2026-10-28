import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { DashboardListCard, DashboardRow } from '@/features/dashboard/card';
import { unreadPreviewQuery, unreadQuery } from './queries';

/** The dashboard's card of unread notifications (the bell's count, the latest few). */
export function UnreadNotificationsCard() {
  const { t } = useTranslation('notifications');
  const list = useQuery(unreadPreviewQuery);
  const unread = useQuery(unreadQuery(false));
  // Read-ness comes from the items: a mark-read rewrites the cached ones.
  const items = (list.data?.items ?? []).filter((item) => !item.read);
  return (
    <DashboardListCard
      title={t('dashboard.title')}
      description={
        unread.data?.unreadCapped
          ? t('dashboard.countCapped')
          : unread.data
            ? t('dashboard.count', { count: unread.data.unread })
            : undefined
      }
      viewAll={<Link to="/notifications" />}
      pending={list.isPending}
      empty={t('dashboard.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <DashboardRow
          key={item.id}
          primary={item.title}
          secondary={item.body}
          at={item.createdAt}
        />
      ))}
    </DashboardListCard>
  );
}
