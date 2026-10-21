import { unwrap } from '@nestjs-monorepo-template/api-client';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { DashboardListCard, DashboardRow } from '@/features/dashboard/card';
import { api } from '@/lib/api';
import { approvalsKey } from './api';

/** The requests waiting for the user, the newest first, with their total. */
export const dashboardQuery = queryOptions({
  queryKey: [...approvalsKey, 'dashboard'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/approvals', {
        params: {
          query: {
            assignedToMe: 'true',
            status: 'pending',
            limit: 5,
            page: 1,
            count: 'true',
          },
        },
      }),
    ),
  // A hint on the home page: a failure is not worth a toast.
  meta: { errorToast: false },
});

/** The dashboard's card of approvals waiting for the user. */
export function PendingApprovalsCard() {
  const { t } = useTranslation('approvals');
  const query = useQuery(dashboardQuery);
  const items = query.data?.items ?? [];
  return (
    <DashboardListCard
      title={t('dashboard.title')}
      description={
        query.data
          ? t('dashboard.count', { count: query.data.total ?? items.length })
          : undefined
      }
      viewAll={<Link to="/approvals" />}
      pending={query.isPending}
      empty={t('dashboard.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <DashboardRow
          key={item.id}
          primary={
            <Link
              to="/approvals/$id"
              params={{ id: item.id }}
              className="hover:underline"
            >
              {item.title}
            </Link>
          }
          secondary={item.requesterName}
          at={item.createdAt}
        />
      ))}
    </DashboardListCard>
  );
}
