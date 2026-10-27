import { unwrap } from '@nestjs-monorepo-template/api-client';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@nestjs-monorepo-template/ui/components/chart';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { DashboardCardFrame } from '@/features/dashboard/card';
import { api } from '@/lib/api';
import { recordKeys } from '@/lib/records';
import { NOTES_PATH } from './api';

/** Weeks in the chart, this one included. */
export const WEEKS = 8;

const DAY = 24 * 3600 * 1000;

/** Monday 00:00 UTC of the week holding `now`. */
export function weekStart(now: Date): Date {
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      sinceMonday * DAY,
  );
}

/** The last `weeks` weeks, oldest first: each as its Monday and its bounds (ISO). */
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
 * The week's counts in one bounded aggregate request. Under the notes' list
 * key, so a write refreshes the chart.
 */
export const weeklyCountsQuery = (from: string) =>
  queryOptions({
    queryKey: [...recordKeys.lists(NOTES_PATH), 'dashboard', 'weeks', from],
    queryFn: () =>
      unwrap(
        api.GET('/v1/notes/dashboard/weekly-counts', {
          params: { query: { from, weeks: WEEKS } },
        }),
      ),
    // A hint on the home page: a failure is not worth a toast.
    meta: { errorToast: false },
  });

/** The dashboard's bar chart of notes created per week. */
export function NotesPerWeekCard() {
  const { t } = useTranslation('notes');
  const ranges = useMemo(() => weekRanges(), []);
  const query = useQuery(weeklyCountsQuery(ranges[0]!.week));
  const config = {
    count: { label: t('dashboard.chart.series'), color: 'var(--chart-2)' },
  } satisfies ChartConfig;
  const counts = new Map(query.data?.map((item) => [item.week, item.count]));
  const pending = query.isPending;
  const data = ranges.map((range) => ({
    week: range.week,
    count: counts.get(range.week) ?? 0,
  }));
  const total = data.reduce((sum, row) => sum + row.count, 0);
  return (
    <DashboardCardFrame
      title={t('dashboard.chart.title')}
      description={t('dashboard.chart.description')}
    >
      {pending ? (
        <Spinner />
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('dashboard.chart.empty')}
        </p>
      ) : (
        <ChartContainer config={config} className="h-56 w-full">
          <BarChart accessibilityLayer data={data}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="week"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value: string) => value.slice(5)}
            />
            <YAxis
              width={32}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            {/* No `labelKey`: it looks the header up in the ChartConfig, which
                has no entry for a week, so the header would be empty. Without
                it the header is the x value, the week's Monday. */}
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={3}
              maxBarSize={48}
            />
          </BarChart>
        </ChartContainer>
      )}
    </DashboardCardFrame>
  );
}
