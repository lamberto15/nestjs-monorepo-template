import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Progress } from '@nestjs-monorepo-template/ui/components/progress';
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
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { CircleAlertIcon, DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/account/section';
import {
  ACCOUNT_EXPORTS_KEY,
  accountExportsQuery,
  startAccountExport,
  type AccountExport,
} from '@/components/account/privacy-api';
import type { TransferFormat } from '@/features/transfer/api';
import { useDateTimeFormat } from '@/lib/date-time';
import { useIsPast } from '@/lib/use-is-past';

const FORMATS: TransferFormat[] = ['json', 'csv', 'xlsx'];

/**
 * A copy of everything held about you (`POST /v1/account/export`): the job
 * runs in the background, then the file downloads. The list is the API's
 * (`GET /v1/account/exports`, `GET /v1/data/transfers` never lists an
 * account export): polled while one runs, and refreshed after a request.
 */
export function ExportSection() {
  const { t } = useTranslation('privacy');
  const { t: tt } = useTranslation('transfer');
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TransferFormat>('json');
  const exports = useInfiniteQuery({
    ...accountExportsQuery,
    meta: { errorToast: false },
  });
  const start = useMutation({
    mutationFn: () => startAccountExport(kind),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ACCOUNT_EXPORTS_KEY }),
  });
  const items = exports.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Section title={t('export.title')} description={t('export.description')}>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-48">
          <FieldLabel htmlFor="account-export-format">
            {tt('export.format')}
          </FieldLabel>
          <Select
            items={FORMATS.map((f) => ({
              value: f,
              label: tt(`formats.${f}`),
            }))}
            value={kind}
            onValueChange={(value) =>
              setKind((value ?? 'json') as TransferFormat)
            }
          >
            <SelectTrigger id="account-export-format" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMATS.map((f) => (
                <SelectItem key={f} value={f}>
                  {tt(`formats.${f}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? <Spinner /> : <DownloadIcon />}
          {t('export.start')}
        </Button>
      </div>
      {/* A failed refetch keeps the exports already shown. */}
      {!exports.data ? (
        exports.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t('export.error')}
          </p>
        ) : (
          <Skeleton className="h-16 w-full" aria-busy />
        )
      ) : items.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('export.empty')}
        </p>
      ) : (
        <ul
          className="flex flex-col divide-y rounded-md border"
          aria-label={t('export.listLabel')}
        >
          {items.map((item) => (
            <ExportRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {exports.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={exports.isFetchingNextPage}
          onClick={() => void exports.fetchNextPage()}
        >
          {exports.isFetchingNextPage && <Spinner />}
          {tt('mine.more')}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{t('export.kept')}</p>
    </Section>
  );
}

/** One export: when it started, its state, and its file when it is ready. */
function ExportRow(props: { item: AccountExport }) {
  const { t } = useTranslation('privacy');
  const { t: tt } = useTranslation('transfer');
  const format = useDateTimeFormat();
  const { item } = props;
  // The API stops listing an export after `expiresAt`; a page left open past
  // it marks the row, without the link, when its time comes.
  const expired = useIsPast(item.expiresAt);
  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{tt(`formats.${item.format}`)}</Badge>
        <span>{t('export.startedAt', { date: format(item.createdAt) })}</span>
        {item.expiresAt && !expired && (
          <span>{t('export.expiresAt', { date: format(item.expiresAt) })}</span>
        )}
      </div>
      <ExportState item={item} expired={expired} />
    </li>
  );
}

function ExportState(props: { item: AccountExport; expired: boolean }) {
  const { t } = useTranslation('privacy');
  const { t: tt } = useTranslation('transfer');
  const { item } = props;
  if (item.status === 'failed') {
    return (
      <Alert variant="destructive" role="alert">
        <CircleAlertIcon />
        <AlertDescription>{item.error ?? tt('status.failed')}</AlertDescription>
      </Alert>
    );
  }
  if (item.status !== 'completed') {
    return (
      <Progress
        value={null}
        aria-label={tt('status.progressLabel')}
        className="flex-col"
      >
        <p role="status" className="text-sm text-muted-foreground">
          {item.status === 'queued'
            ? tt('status.queued')
            : tt('status.running', { count: item.progress.processed ?? 0 })}
        </p>
      </Progress>
    );
  }
  if (props.expired) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('export.expired')}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-sm">
        {tt('export.done', { count: item.result?.rows ?? 0 })}
      </p>
      {item.result?.url && (
        // A signed link (30 minutes from this answer) that names the file.
        <a
          href={item.result.url}
          download
          className={buttonVariants({ variant: 'default', size: 'sm' })}
        >
          <DownloadIcon />
          {tt('export.download', { format: item.format })}
        </a>
      )}
    </div>
  );
}
