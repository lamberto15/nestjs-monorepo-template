import { isApiError } from '@nestjs-monorepo-template/api-client';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { buttonVariants } from '@nestjs-monorepo-template/ui/components/button';
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
import { useQuery } from '@tanstack/react-query';
import { CircleAlertIcon, DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseRowErrors } from './csv';
import { transferQuery, type Transfer } from './api';

/** The report shows this many refused rows; the CSV has all of them. */
const SHOWN_ERRORS = 100;

/**
 * One transfer on screen: the worker's progress (polled), then the file to
 * download (an export) or the counts and the refused rows (an import).
 */
export function TransferStatus(props: { id: string }) {
  const { t } = useTranslation('transfer');
  const query = useQuery({
    ...transferQuery(props.id),
    meta: { errorToast: false },
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
  const transfer = query.data;

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
  return transfer.kind === 'export' ? (
    <ExportDone transfer={transfer} />
  ) : (
    <ImportReport transfer={transfer} />
  );
}

function ExportDone(props: { transfer: Transfer }) {
  const { t } = useTranslation('transfer');
  const { result } = props.transfer;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-sm">
        {t('export.done', { count: result?.rows ?? 0 })}
      </p>
      {result?.url && (
        // A signed link (30 minutes) that names the file itself.
        <a
          href={result.url}
          download
          className={buttonVariants({ variant: 'default', size: 'sm' })}
        >
          <DownloadIcon />
          {t('export.download', { format: props.transfer.format })}
        </a>
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
