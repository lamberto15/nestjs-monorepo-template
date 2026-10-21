import { useQueries, useQuery } from '@tanstack/react-query';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@nestjs-monorepo-template/ui/components/chart';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Stat,
  StatDescription,
  StatLabel,
  StatValue,
} from '@nestjs-monorepo-template/ui/components/stat';
import { Link } from '@tanstack/react-router';
import {
  BellIcon,
  ClipboardCheckIcon,
  FilePlusIcon,
  ScrollTextIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { RelativeTime } from '@/features/notifications/relative-time';
import { unreadQuery } from '@/features/notifications/queries';
import { holds, useFeatures, useMe, type Gated } from '@/lib/features';
import {
  pendingApprovalsQuery,
  recentActivityQuery,
  recentRecordsQuery,
  unreadNotificationsQuery,
  weekRanges,
  weeklyCountQuery,
} from './api';

/** A card's frame: a title, a link to the whole list, and its rows or an empty line. */
function ListCard(props: {
  title: string;
  to: '/approvals' | '/notifications' | '/audit' | '/notes';
  pending: boolean;
  empty: string;
  children: ReactNode;
  isEmpty: boolean;
}) {
  const { t } = useTranslation('dashboard');
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {props.title}
        </CardTitle>
        <CardAction>
          <Button
            size="sm"
            variant="ghost"
            nativeButton={false}
            render={<Link to={props.to} />}
          >
            {t('viewAll')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {props.pending ? (
          <Spinner />
        ) : props.isEmpty ? (
          <p className="text-sm text-muted-foreground">{props.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y">{props.children}</ul>
        )}
      </CardContent>
    </Card>
  );
}

function Row(props: {
  primary: ReactNode;
  secondary?: ReactNode;
  at?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{props.primary}</span>
        {props.secondary && (
          <span className="truncate text-xs text-muted-foreground">
            {props.secondary}
          </span>
        )}
      </span>
      {props.at && (
        <span className="shrink-0 text-xs text-muted-foreground">
          <RelativeTime value={props.at} />
        </span>
      )}
    </li>
  );
}

function PendingApprovalsCard() {
  const { t } = useTranslation('dashboard');
  const query = useQuery(pendingApprovalsQuery);
  const items = query.data?.items ?? [];
  return (
    <ListCard
      title={t('approvals.title')}
      to="/approvals"
      pending={query.isPending}
      empty={t('approvals.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <Row
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
    </ListCard>
  );
}

function UnreadNotificationsCard() {
  const { t } = useTranslation('dashboard');
  const query = useQuery(unreadNotificationsQuery);
  const items = query.data?.items ?? [];
  return (
    <ListCard
      title={t('notifications.title')}
      to="/notifications"
      pending={query.isPending}
      empty={t('notifications.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <Row
          key={item.id}
          primary={item.title}
          secondary={item.body}
          at={item.createdAt}
        />
      ))}
    </ListCard>
  );
}

function RecentActivityCard() {
  const { t } = useTranslation('dashboard');
  const query = useQuery(recentActivityQuery);
  const items = query.data?.items ?? [];
  return (
    <ListCard
      title={t('activity.title')}
      to="/audit"
      pending={query.isPending}
      empty={t('activity.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <Row
          key={item.id}
          primary={item.action}
          secondary={item.actorName ?? item.actorLabel}
          at={item.at}
        />
      ))}
    </ListCard>
  );
}

function RecentRecordsCard() {
  const { t } = useTranslation('dashboard');
  const query = useQuery(recentRecordsQuery);
  const items = query.data?.items ?? [];
  return (
    <ListCard
      title={t('records.title')}
      to="/notes"
      pending={query.isPending}
      empty={t('records.empty')}
      isEmpty={items.length === 0}
    >
      {items.map((item) => (
        <Row
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
    </ListCard>
  );
}

function RecordsPerWeekCard() {
  const { t } = useTranslation('dashboard');
  const ranges = useMemo(() => weekRanges(), []);
  const results = useQueries({
    queries: ranges.map((range) => weeklyCountQuery(range)),
  });
  const config = {
    count: { label: t('chart.series'), color: 'var(--primary)' },
  } satisfies ChartConfig;
  const pending = results.some((result) => result.isPending);
  const data = ranges.map((range, i) => ({
    week: range.week,
    count: results[i]?.data ?? 0,
  }));
  const total = data.reduce((sum, row) => sum + row.count, 0);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {t('chart.title')}
        </CardTitle>
        <CardDescription>{t('chart.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {pending ? (
          <Spinner />
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">{t('chart.empty')}</p>
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
              <ChartTooltip content={<ChartTooltipContent labelKey="week" />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={3} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

type QuickAction = Gated & {
  to: '/notes/new' | '/approvals' | '/notifications' | '/audit';
  label: string;
  icon: typeof FilePlusIcon;
};

const quickActions: QuickAction[] = [
  {
    to: '/notes/new',
    label: 'quick.newNote',
    icon: FilePlusIcon,
    permission: 'Note.create',
  },
  { to: '/approvals', label: 'quick.approvals', icon: ClipboardCheckIcon },
  { to: '/notifications', label: 'quick.notifications', icon: BellIcon },
  {
    to: '/audit',
    label: 'quick.audit',
    icon: ScrollTextIcon,
    permission: 'Access.readAudit',
  },
];

function QuickActionsCard() {
  const { t } = useTranslation('dashboard');
  const features = useFeatures();
  const me = useMe();
  const shown = quickActions.filter(
    (action) =>
      (!action.feature || features?.[action.feature] === true) &&
      (!action.permission || holds(me?.can, action.permission)),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {t('quick.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {shown.map((action) => (
          <Button
            key={action.to}
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to={action.to} />}
          >
            <action.icon aria-hidden />
            {t(action.label)}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

function Stats() {
  const { t } = useTranslation('dashboard');
  const approvals = useQuery(pendingApprovalsQuery);
  const unread = useQuery(unreadQuery(false));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Stat>
        <StatLabel>{t('approvals.stat')}</StatLabel>
        <StatValue>{(approvals.data?.total ?? 0).toLocaleString()}</StatValue>
        <StatDescription>{t('approvals.statHint')}</StatDescription>
      </Stat>
      <Stat>
        <StatLabel>{t('notifications.stat')}</StatLabel>
        <StatValue>{(unread.data?.unread ?? 0).toLocaleString()}</StatValue>
        <StatDescription>{t('notifications.statHint')}</StatDescription>
      </Stat>
    </div>
  );
}

/**
 * The home page: what waits for the user, what happened, what changed. Each
 * card shows only with its permission and switch (hiding is for the user; the
 * API refuses either way), and a card asks only for its own data.
 */
export function Dashboard() {
  const { t } = useTranslation('dashboard');
  const me = useMe();
  const can = (permission: string) => me?.can[permission] === true;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Stats />
      <div className="grid gap-4 lg:grid-cols-2">
        <PendingApprovalsCard />
        <UnreadNotificationsCard />
        {can('Access.readAudit') && <RecentActivityCard />}
        {can('Note.read') && <RecentRecordsCard />}
        {can('Note.read') && <RecordsPerWeekCard />}
        <QuickActionsCard />
      </div>
    </div>
  );
}
