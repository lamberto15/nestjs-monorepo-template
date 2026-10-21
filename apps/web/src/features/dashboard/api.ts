import { unwrap } from '@nestjs-monorepo-template/api-client';
import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** How many rows a list card shows. */
export const CARD_ROWS = 5;
/** Weeks in the chart, this one included. */
export const WEEKS = 8;

/** Every dashboard query starts with this key. */
export const dashboardKey = ['dashboard'] as const;

// The cards only hint: a failure (a 403 for a card the role may not read) is
// not worth a toast.
const quiet = { errorToast: false } as const;

/** The requests waiting for the user, the newest first. */
export const pendingApprovalsQuery = queryOptions({
  queryKey: [...dashboardKey, 'approvals'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/approvals', {
        params: {
          query: {
            assignedToMe: 'true',
            status: 'pending',
            limit: CARD_ROWS,
            page: 1,
            count: 'true',
          },
        },
      }),
    ),
  meta: quiet,
});

/** The unread notifications, the newest first (the count is the bell's own query). */
export const unreadNotificationsQuery = queryOptions({
  queryKey: [...dashboardKey, 'notifications'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/notifications', {
        params: { query: { read: 'false', limit: CARD_ROWS } },
      }),
    ),
  meta: quiet,
});

/** The latest audit entries (`Access.readAudit`). */
export const recentActivityQuery = queryOptions({
  queryKey: [...dashboardKey, 'audit'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/access/audit', {
        params: { query: { limit: CARD_ROWS, sort: '-at' } },
      }),
    ),
  meta: quiet,
});

/** The records changed last (notes, the example feature: `Note.read`). */
export const recentRecordsQuery = queryOptions({
  queryKey: [...dashboardKey, 'records'],
  queryFn: () =>
    unwrap(
      api.GET('/v1/notes', {
        params: {
          query: {
            limit: CARD_ROWS,
            sort: '-updatedAt',
            fields: 'id,number,title,status,updatedAt',
          },
        },
      }),
    ),
  meta: quiet,
});

const DAY = 24 * 3600 * 1000;

/** Monday 00:00 UTC of the week holding `now`. */
export function weekStart(now: Date): Date {
  const day = (now.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      day * DAY,
  );
}

/** The last `WEEKS` weeks, oldest first: each as its start and end (ISO). */
export function weekRanges(now = new Date(), weeks = WEEKS) {
  const current = weekStart(now).getTime();
  return Array.from({ length: weeks }, (_, i) => {
    const start = current - (weeks - 1 - i) * 7 * DAY;
    return {
      week: new Date(start).toISOString().slice(0, 10),
      from: new Date(start).toISOString(),
      to: new Date(start + 7 * DAY - 1).toISOString(),
    };
  });
}

/**
 * Notes created in one week: a one-row page with `count=true`, so the API
 * counts and no rows travel (there is no aggregate route).
 */
export const weeklyCountQuery = (range: { from: string; to: string }) =>
  queryOptions({
    queryKey: [...dashboardKey, 'weekly', range.from],
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/notes', {
            params: {
              query: {
                'createdAt.between': `${range.from},${range.to}`,
                limit: 1,
                page: 1,
                count: 'true',
                fields: 'id',
              },
            },
          }),
        )
      ).total ?? 0,
    meta: quiet,
  });
