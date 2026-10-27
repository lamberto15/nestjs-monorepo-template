import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ACCOUNT_EXPORTS_KEY,
  accountExportsQuery,
} from '@/components/account/privacy-api';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useDateTimeFormat } from '@/lib/date-time';
import { useLivePoll, useRealtimeEvent, withProgress } from '@/lib/realtime';
import {
  bulkListQuery,
  transfersListQuery,
  type BulkRun,
  type Transfer,
  type TransferKind,
  type TransferState,
} from './api';
import { TransferView } from './transfer-status';

type JobItem = {
  id: string;
  status: string;
  progress: Record<string, number>;
};

type Show = 'all' | TransferKind | 'account' | 'bulk';
type StatusFilter = 'all' | TransferState;

const STATES: TransferState[] = ['queued', 'running', 'completed', 'failed'];

/**
 * The caller's exports, imports and bulk runs in this tenant, and their
 * account exports (across tenants), from the API (`GET /v1/data/transfers`,
 * `GET /v1/bulk`, `GET /v1/account/exports`): newest first, a page at a time,
 * including those started on other devices or by scheduled reports. The kind
 * and the status are filters of the API, not of what was fetched.
 */
export function TransfersPage() {
  const { t } = useTranslation('transfer');
  const [show, setShow] = useState<Show>('all');
  const [state, setState] = useState<StatusFilter>('all');
  const status = state === 'all' ? undefined : state;
  const showTransfers = show !== 'bulk' && show !== 'account';
  const showBulk = show === 'all' || show === 'bulk';
  // An account export is an export, in no tenant: its own list.
  const showAccount = show === 'all' || show === 'export' || show === 'account';
  const kind = show === 'export' || show === 'import' ? show : undefined;

  // The ends come as events: the lists are refetched for the one that
  // ended, and polled only without a connected socket (useLivePoll).
  const queryClient = useQueryClient();
  const poll = useLivePoll(2000);
  const transfers = useInfiniteQuery({
    ...transfersListQuery(kind, status, poll.interval),
    enabled: showTransfers,
  });
  const bulk = useInfiniteQuery({
    ...bulkListQuery(status, poll.interval),
    enabled: showBulk,
  });
  // The same query as the account page's export section (shared cache). The
  // API has no status filter for it: the few it keeps are filtered here.
  const account = useInfiniteQuery({
    ...accountExportsQuery,
    enabled: showAccount,
    meta: { errorToast: false },
  });
  const ended = (event: { id: string }) => {
    poll.push(event.id);
    void queryClient.invalidateQueries({ queryKey: ['data', 'transfers'] });
    void queryClient.invalidateQueries({ queryKey: ['data', 'bulk-runs'] });
    void queryClient.invalidateQueries({ queryKey: ACCOUNT_EXPORTS_KEY });
  };
  useRealtimeEvent('data.export-ready', ended);
  useRealtimeEvent('data.import-finished', ended);
  useRealtimeEvent('bulk.finished', ended);
  useRealtimeEvent('data.failed', ended);
  useRealtimeEvent('bulk.failed', ended);
  // Progress events update the counters of the shown item in place.
  const progressed = (
    key: 'transfers' | 'bulk-runs',
    id: string,
    counters: Record<string, number | undefined>,
  ) =>
    queryClient.setQueriesData<InfiniteData<{ items: JobItem[] }>>(
      { queryKey: ['data', key] },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              item.id === id ? withProgress(item, counters) : item,
            ),
          })),
        },
    );
  useRealtimeEvent('data.progress', ({ id, processed, imported, failed }) =>
    progressed('transfers', id, { processed, imported, failed }),
  );
  useRealtimeEvent('bulk.progress', ({ id, processed, done, failed }) =>
    progressed('bulk-runs', id, { processed, done, failed }),
  );

  const items = showTransfers
    ? (transfers.data?.pages.flatMap((page) => page.items) ?? [])
    : [];
  const runs = showBulk ? (bulk.data?.pages.flatMap((p) => p.items) ?? []) : [];
  const accountItems = showAccount
    ? (account.data?.pages
        .flatMap((page) => page.items)
        .filter((item) => !status || item.status === status) ?? [])
    : [];
  // The account list may be refused (an impersonated session): that alone
  // does not hide the rest, unless it is all there is.
  const accountOnly = show === 'account';
  const pending =
    (showTransfers && transfers.isPending) ||
    (showBulk && bulk.isPending) ||
    (showAccount && account.isPending);
  const failed =
    (showTransfers && transfers.isError) ||
    (showBulk && bulk.isError) ||
    (accountOnly && account.isError);

  const filters: { value: Show; label: string }[] = [
    { value: 'all', label: t('mine.filter.all') },
    { value: 'export', label: t('mine.filter.export') },
    { value: 'import', label: t('mine.filter.import') },
    { value: 'account', label: t('mine.filter.account') },
    { value: 'bulk', label: t('mine.filter.bulk') },
  ];
  const states: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: t('mine.state.all') },
    ...STATES.map((value) => ({ value, label: t(`mine.state.${value}`) })),
  ];

  return (
    <Page>
      <PageHeader
        title={t('mine.title')}
        description={t('mine.description')}
        actions={
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/transfers/import" />}
          >
            {t('mine.import')}
          </Button>
        }
      />
      <div className="flex flex-wrap gap-2">
        <Select
          items={filters}
          value={show}
          onValueChange={(value) => setShow((value as Show | null) ?? 'all')}
        >
          <SelectTrigger aria-label={t('mine.filter.label')} className="w-fit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filters.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={states}
          value={state}
          onValueChange={(value) =>
            setState((value as StatusFilter | null) ?? 'all')
          }
        >
          <SelectTrigger aria-label={t('mine.state.label')} className="w-fit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {states.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {pending ? (
        <Skeleton className="h-20 w-full" aria-busy />
      ) : failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('mine.error')}
        </p>
      ) : items.length === 0 &&
        runs.length === 0 &&
        accountItems.length === 0 &&
        !(showTransfers && transfers.hasNextPage) &&
        !(showBulk && bulk.hasNextPage) &&
        !(showAccount && account.hasNextPage) ? (
        <EmptyState
          title={status ? t('mine.emptyFiltered') : t('mine.empty')}
        />
      ) : (
        <>
          {items.length > 0 && <TransferRows items={items} />}
          {showTransfers && transfers.hasNextPage && (
            <MoreButton
              busy={transfers.isFetchingNextPage}
              onClick={() => void transfers.fetchNextPage()}
            />
          )}
          {accountItems.length > 0 && (
            <TransferRows
              items={accountItems}
              account
              label={t('mine.accountTitle')}
            />
          )}
          {showAccount && account.hasNextPage && (
            <MoreButton
              busy={account.isFetchingNextPage}
              onClick={() => void account.fetchNextPage()}
            />
          )}
          {runs.length > 0 && <BulkRows runs={runs} />}
          {showBulk && bulk.hasNextPage && (
            <MoreButton
              busy={bulk.isFetchingNextPage}
              onClick={() => void bulk.fetchNextPage()}
            />
          )}
        </>
      )}
    </Page>
  );
}

function MoreButton(props: { busy: boolean; onClick: () => void }) {
  const { t } = useTranslation('transfer');
  return (
    <Button
      variant="outline"
      className="self-start"
      disabled={props.busy}
      onClick={props.onClick}
    >
      {props.busy && <Spinner />}
      {t('mine.more')}
    </Button>
  );
}

function TransferRows(props: {
  items: Transfer[];
  account?: boolean;
  label?: string;
}) {
  const { t } = useTranslation('transfer');
  const format = useDateTimeFormat();
  return (
    <ul
      className="flex flex-col gap-3"
      aria-label={props.label ?? t('mine.title')}
    >
      {props.items.map((item) => (
        <li key={item.id} className="rounded-lg border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">
              {t(props.account ? 'kind.account' : `kind.${item.kind}`)}
            </Badge>
            <span className="font-medium">{item.name}</span>
          </div>
          <p className="mb-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>{t('mine.started', { date: format(item.createdAt) })}</span>
            {item.finishedAt && (
              <span>
                {t('mine.finished', { date: format(item.finishedAt) })}
              </span>
            )}
            {item.expiresAt && (
              <span>
                {t('mine.keptUntil', { date: format(item.expiresAt) })}
              </span>
            )}
          </p>
          <TransferView transfer={item} />
        </li>
      ))}
    </ul>
  );
}

function BulkRows(props: { runs: BulkRun[] }) {
  const { t } = useTranslation('transfer');
  return (
    <ul className="flex flex-col gap-3" aria-label={t('mine.bulkTitle')}>
      {props.runs.map((run) => (
        <li key={run.id} className="rounded-lg border p-3" data-bulk={run.id}>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">{t('kind.bulk')}</Badge>
            <span className="font-medium">
              {run.name} · {run.action}
            </span>
          </div>
          <BulkState run={run} />
        </li>
      ))}
    </ul>
  );
}

function BulkState(props: { run: BulkRun }) {
  const { t } = useTranslation('transfer');
  const { run } = props;
  if (run.status === 'failed') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {run.error ?? t('bulk.failed')}
      </p>
    );
  }
  if (run.status === 'queued') {
    return <p className="text-sm text-muted-foreground">{t('bulk.queued')}</p>;
  }
  if (run.status === 'running') {
    return (
      <p className="text-sm text-muted-foreground">
        {t('bulk.running', { count: run.progress.processed ?? 0 })}
      </p>
    );
  }
  return (
    <p className="text-sm">
      {t('bulk.result', {
        done: run.result?.done ?? 0,
        failed: run.result?.failed ?? 0,
        skipped: run.result?.skipped ?? 0,
      })}
    </p>
  );
}
