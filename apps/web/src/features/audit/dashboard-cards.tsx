import { unwrap } from '@nestjs-monorepo-template/api-client';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { DashboardListCard, DashboardRow } from '@/features/dashboard/card';
import { api } from '@/lib/api';

/** The latest audit entries (`Access.readAudit`). */
export const recentActivityQuery = queryOptions({
  queryKey: ['audit', 'dashboard'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/access/audit', {
        params: { query: { limit: 5, sort: '-at' } },
      }),
    ),
  // A hint on the home page: a failure is not worth a toast.
  meta: { errorToast: false },
});

/** The dashboard's card of the latest audit entries. */
export function RecentActivityCard() {
  const { t } = useTranslation('audit');
  const query = useQuery(recentActivityQuery);
  const items = query.data?.items ?? [];
  return (
    <DashboardListCard
      title={t('dashboard.title')}
      viewAll={<Link to="/audit" />}
      pending={query.isPending}
      empty={t('dashboard.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <DashboardRow
          key={item.id}
          primary={item.action}
          secondary={item.actorName ?? item.actorLabel}
          at={item.at}
        />
      ))}
    </DashboardListCard>
  );
}
