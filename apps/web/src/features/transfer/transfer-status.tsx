import { isApiError } from '@nestjs-monorepo-template/api-client';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import { Progress } from '@nestjs-monorepo-template/ui/components/progress';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlertIcon, DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLivePoll, useRealtimeEvent, withProgress } from '@/lib/realtime';
import { useIsPast } from '@/lib/use-is-past';
import { parseRowErrors } from './csv';
import { freshExportUrl, POLL, transferQuery, type Transfer } from './api';
import { useState } from 'react';

/** The report shows this many refused rows; the CSV has all of them. */
const SHOWN_ERRORS = 100;

/**
 * One transfer on screen: the worker's progress, then the file to download
 * (an export) or the counts and the refused rows (an import). Its end comes
 * as a realtime event (`data.export-ready`, `data.import-finished`,
 * `data.failed`) for this id and its progress as `data.progress`; the job is
 * polled every second only when there is no connected socket (useLivePoll).
 */
export function TransferStatus(props: { id: string }) {
  const { t } = useTranslation('transfer');
  const queryClient = useQueryClient();
  const poll = useLivePoll(POLL);
  const query = useQuery({
    ...transferQuery(props.id, (status) =>
      poll.interval([{ id: props.id, status }]),
    ),
    meta: { errorToast: false },
  });
  const ended = (event: { id: string }) => {
    if (event.id !== props.id) {
      return;
    }
    poll.push(props.id);
    void queryClient.invalidateQueries({
      queryKey: transferQuery(props.id).queryKey,
    });
  };
  useRealtimeEvent('data.export-ready', ended);
  useRealtimeEvent('data.import-finished', ended);
  useRealtimeEvent('data.failed', ended);
  useRealtimeEvent('data.progress', (event) => {
    if (event.id !== props.id) {
      return;
    }
    queryClient.setQueryData(
      transferQuery(props.id).queryKey,
      (job) =>
        job &&
        withProgress(job, {
          processed: event.processed,
          imported: event.imported,
          failed: event.failed,
        }),
    );
  });

  if (query.isPending) {
    return <Skeleton className="h-10 w-full" aria-busy />;
  }
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {isApiError(query.error) && query.error.status === 404
          ? t('status.notFound')
          : t('status.error')}
      </p>
    );
  }
  return <TransferView transfer={query.data} />;
}

/**
 * A transfer as the API tells it, with no request of its own: the progress,
 * then the file to download (an export) or the counts and the refused rows
 * (an import). A list's item is one (it carries the same fields), and so is
 * the answer of the single route. Once `expiresAt` has passed the links are
 * not offered: the API no longer gives them.
 */
export function TransferView(props: { transfer: Transfer; account?: boolean }) {
  const { t } = useTranslation('transfer');
  const { transfer } = props;
  // The API stops giving the links after `expiresAt`; a page left open past
  // it drops them when its time comes.
  const expired = useIsPast(transfer.expiresAt);

  if (transfer.status === 'failed') {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlertIcon />
        <AlertDescription>
          {transfer.error ?? t('status.failed')}
        </AlertDescription>
      </Alert>
    );
  }
  if (transfer.status !== 'completed') {
    const processed = transfer.progress.processed ?? 0;
    return (
      <Progress
        value={null}
        aria-label={t('status.progressLabel')}
        className="flex-col"
      >
        <p role="status" className="text-sm text-muted-foreground">
          {transfer.status === 'queued'
            ? t('status.queued')
            : t('status.running', { count: processed })}
        </p>
      </Progress>
    );
  }
  if (expired) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('status.expired')}
      </p>
    );
  }
  return transfer.kind === 'export' ? (
    <ExportDone transfer={transfer} account={props.account} />
  ) : (
    <ImportReport transfer={transfer} />
  );
}

function ExportDone(props: { transfer: Transfer; account?: boolean }) {
  const { t } = useTranslation('transfer');
  const { result } = props.transfer;
  const [opening, setOpening] = useState(false);
  const download = async () => {
    setOpening(true);
    const tab = window.open('', '_blank');
    try {
      const url = await freshExportUrl(props.transfer.id, props.account);
      if (tab && url) tab.location.href = url;
      else tab?.close();
    } catch {
      tab?.close();
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-sm">
        {t('export.done', { count: result?.rows ?? 0 })}
      </p>
      {result?.url && (
        // Re-read status on demand so every open gets a fresh signed link.
        <Button size="sm" disabled={opening} onClick={download}>
          <DownloadIcon />
          {t('export.download', { format: props.transfer.format })}
        </Button>
      )}
      {(props.transfer.format === 'csv' ||
        props.transfer.format === 'json') && (
        <Link
          to="/analytics"
          search={{
            transferId: props.transfer.id,
            ...(props.account && { account: true }),
          }}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('export.openInAnalytics')}
        </Link>
      )}
    </div>
  );
}

function ImportReport(props: { transfer: Transfer }) {
  const { t } = useTranslation('transfer');
  const { result } = props.transfer;
  const failed = result?.failed ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-sm font-medium">
        {result?.dryRun
          ? t('import.checked', {
              rows: result.rows,
              valid: result.imported ?? 0,
              failed,
            })
          : t('import.imported', {
              rows: result?.rows ?? 0,
              imported: result?.imported ?? 0,
              failed,
            })}
      </p>
      {result?.errorsUrl && (
        <RowErrors url={result.errorsUrl} id={props.transfer.id} />
      )}
    </div>
  );
}

/**
 * The refused rows: row, field, message. The report is a file in storage
 * behind a signed link; reading it here needs the storage to allow this
 * origin (CORS), else only the download link is shown.
 */
function RowErrors(props: { url: string; id: string }) {
  const { t } = useTranslation('transfer');
  const query = useQuery({
    queryKey: ['data', 'transfer', props.id, 'errors'],
    queryFn: async () => {
      const response = await fetch(props.url);
      if (!response.ok) throw new Error(String(response.status));
      return parseRowErrors(await response.text());
    },
    retry: false,
    meta: { errorToast: false },
  });
  const rows = query.data ?? [];
  return (
    <div className="flex flex-col gap-2">
      {query.isPending && <Skeleton className="h-16 w-full" aria-busy />}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <Table aria-label={t('import.errorsTitle')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('import.row')}</TableHead>
                <TableHead>{t('import.field')}</TableHead>
                <TableHead>{t('import.message')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, SHOWN_ERRORS).map((error, index) => (
                <TableRow key={`${error.row}-${error.field}-${index}`}>
                  <TableCell className="tabular-nums">{error.row}</TableCell>
                  <TableCell>{error.field}</TableCell>
                  <TableCell>{error.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {rows.length > SHOWN_ERRORS && (
        <p className="text-xs text-muted-foreground">
          {t('import.moreErrors', { count: rows.length - SHOWN_ERRORS })}
        </p>
      )}
      <a
        href={props.url}
        download
        className={buttonVariants({
          variant: 'outline',
          size: 'sm',
          className: 'self-start',
        })}
      >
        <DownloadIcon />
        {t('import.downloadErrors')}
      </a>
    </div>
  );
}
