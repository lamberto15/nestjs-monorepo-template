import { useQuery } from '@tanstack/react-query';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@nestjs-monorepo-template/ui/components/chart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Stat,
  StatDescription,
  StatLabel,
  StatValue,
} from '@nestjs-monorepo-template/ui/components/stat';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { clientsQuery, usageQuery, type Usage } from './queries';

export const usageRanges = ['7', '30', '90'] as const;
export type UsageRange = (typeof usageRanges)[number];

const day = (date: Date) => date.toISOString().slice(0, 10);

/** UTC days, `days` of them, ending today (both ends included). */
export function rangeFor(days: UsageRange, now = new Date()) {
  const to = day(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (Number(days) - 1));
  return { from: day(start), to };
}

/** Requests per route over the whole period, most first. */
export function byRoute(usage: Usage) {
  const totals = new Map<string, number>();
  for (const entry of usage.days) {
    for (const [route, count] of Object.entries(entry.routes)) {
      totals.set(route, (totals.get(route) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([route, count]) => ({ route, count }))
    .toSorted((a, b) => b.count - a.count || a.route.localeCompare(b.route));
}

/** Usage of one API client: today against its quota, a daily chart, by route. */
export function UsagePage(props: { client?: string; days: UsageRange }) {
  const { t } = useTranslation('api-clients');
  const navigate = useNavigate({ from: '/api-clients/usage' });
  const clients = useQuery(clientsQuery);
  const items = clients.data?.items ?? [];
  const selected = items.find((item) => item.id === props.client) ?? items[0];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-medium">{t('usage.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('usage.description')}
        </p>
      </div>
      {clients.isPending ? (
        <Spinner />
      ) : !selected ? (
        <p className="text-sm text-muted-foreground">{t('usage.noClients')}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" id="usage-client">
                {t('usage.client')}
              </label>
              <Select
                value={selected.id}
                onValueChange={(value) =>
                  void navigate({
                    search: (prev) => ({ ...prev, client: value ?? undefined }),
                  })
                }
                items={items.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              >
                <SelectTrigger aria-labelledby="usage-client" className="w-64">
                  <SelectValue placeholder={t('usage.selectClient')} />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" id="usage-range">
                {t('usage.range')}
              </label>
              <Select
                value={props.days}
                onValueChange={(value) =>
                  void navigate({
                    search: (prev) => ({
                      ...prev,
                      days: (value ?? '30') as UsageRange,
                    }),
                  })
                }
                items={usageRanges.map((value) => ({
                  value,
                  label: t(`usage.ranges.${value}`),
                }))}
              >
                <SelectTrigger aria-labelledby="usage-range" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {usageRanges.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`usage.ranges.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <UsageReport
            id={selected.id}
            days={props.days}
            quota={selected.dailyQuota}
          />
        </>
      )}
    </div>
  );
}

function UsageReport(props: {
  id: string;
  days: UsageRange;
  quota: number | null;
}) {
  const { t } = useTranslation('api-clients');
  const { from, to } = useMemo(() => rangeFor(props.days), [props.days]);
  const usage = useQuery(usageQuery(props.id, from, to));
  const chartConfig = {
    total: { label: t('usage.chart.series'), color: 'var(--chart-1)' },
  } satisfies ChartConfig;
  if (usage.isPending) {
    return <Spinner />;
  }
  if (!usage.data) {
    return null;
  }
  const today = usage.data.days.find((entry) => entry.day === to)?.total ?? 0;
  const routes = byRoute(usage.data);
  const total = usage.data.total;
  const quota = props.quota;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat>
          <StatLabel>{t('usage.stats.total')}</StatLabel>
          <StatValue>{total.toLocaleString()}</StatValue>
        </Stat>
        <Stat>
          <StatLabel>{t('usage.stats.today')}</StatLabel>
          <StatValue>{today.toLocaleString()}</StatValue>
          <StatDescription>
            {quota === null
              ? t('usage.stats.noQuota')
              : today >= quota
                ? t('usage.stats.overQuota')
                : t('usage.stats.remaining', { count: quota - today })}
          </StatDescription>
        </Stat>
        <Stat>
          <StatLabel>{t('usage.stats.quota')}</StatLabel>
          <StatValue>
            {quota === null ? t('usage.stats.noQuota') : quota.toLocaleString()}
          </StatValue>
          {quota !== null && (
            <StatDescription>
              {t('usage.stats.usedOf', {
                used: today.toLocaleString(),
                quota: quota.toLocaleString(),
              })}
            </StatDescription>
          )}
        </Stat>
      </div>
      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="font-medium">{t('usage.chart.title')}</h2>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('usage.chart.empty')}
          </p>
        ) : (
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <BarChart accessibilityLayer data={usage.data.days}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <YAxis
                width={40}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <ChartTooltip content={<ChartTooltipContent labelKey="day" />} />
              <Bar dataKey="total" fill="var(--color-total)" radius={3} />
            </BarChart>
          </ChartContainer>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t('usage.routes.title')}</h2>
        {routes.length ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('usage.routes.route')}</TableHead>
                  <TableHead className="text-end">
                    {t('usage.routes.requests')}
                  </TableHead>
                  <TableHead className="text-end">
                    {t('usage.routes.share')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((entry) => (
                  <TableRow key={entry.route}>
                    <TableCell className="font-mono text-xs">
                      {entry.route}
                    </TableCell>
                    <TableCell className="text-end">
                      {entry.count.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-end">
                      {total
                        ? new Intl.NumberFormat(undefined, {
                            style: 'percent',
                            maximumFractionDigits: 0,
                          }).format(entry.count / total)
                        : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('usage.routes.empty')}
          </p>
        )}
      </section>
    </>
  );
}
