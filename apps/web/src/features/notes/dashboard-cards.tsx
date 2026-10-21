import { unwrap } from '@nestjs-monorepo-template/api-client';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { DashboardListCard, DashboardRow } from '@/features/dashboard/card';
import { api } from '@/lib/api';
import { recordKeys } from '@/lib/records';
import { NOTES_PATH } from './api';

/**
 * The notes changed last. Under the notes' list key, so a write that
 * refreshes the lists refreshes this card too.
 */
export const recentNotesQuery = queryOptions({
  queryKey: [...recordKeys.lists(NOTES_PATH), 'dashboard', 'recent'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/notes', {
        params: {
          query: {
            limit: 5,
            sort: '-updatedAt',
            fields: 'id,number,title,status,updatedAt',
          },
        },
      }),
    ),
  // A hint on the home page: a failure is not worth a toast.
  meta: { errorToast: false },
});

/** The dashboard's card of the recently changed notes. */
export function RecentNotesCard() {
  const { t } = useTranslation('notes');
  const query = useQuery(recentNotesQuery);
  const items = query.data?.items ?? [];
  return (
    <DashboardListCard
      title={t('dashboard.recent.title')}
      viewAll={<Link to="/notes" />}
      pending={query.isPending}
      empty={t('dashboard.recent.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <DashboardRow
          key={item.id}
          primary={
            <Link
              to="/notes/$id"
              params={{ id: item.id }}
              className="hover:underline"
            >
              {item.title}
            </Link>
          }
          secondary={item.number ?? undefined}
          at={item.updatedAt}
        />
      ))}
    </DashboardListCard>
  );
}
