import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Stat,
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
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';
import {
  opsOutboxQuery,
  usePurgeDeadLetters,
  useRequeueDeadLetters,
} from './queries';

/** The outbox's lag in a unit a person reads: `0 s`, `4.2 s`, `3 min`. */
export function formatLag(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 100) / 10} s`;
  }
  return `${Math.round(ms / 60_000)} min`;
}

/** The outbox: its counters, and the dead letters (requeue, purge). */
export function OutboxPanel() {
  const { t } = useTranslation('ops');
  const outbox = useQuery(opsOutboxQuery);
  const requeue = useRequeueDeadLetters();
  const purge = usePurgeDeadLetters();
  const canManage = useCan('Ops.manage');
  if (outbox.isPending) {
    return <Spinner />;
  }
  if (outbox.isError) {
    return <FormAlert message={errorMessage(outbox.error)} />;
  }
  const { stats, deadLetters, notifications } = outbox.data;
  const counters = [
    ['pending', stats.pending],
    ['ready', stats.ready],
    ['leased', stats.leased],
    ['inFlight', stats.inFlight],
    ['deadLetters', stats.deadLetters],
    ['lag', formatLag(stats.lagMs)],
    ['undelivered', notifications.undelivered],
  ] as const;
  const requeued = (count: number) =>
    toast.success(t('outbox.requeued', { count }));
  const purged = (count: number) =>
    toast.success(t('outbox.purged', { count }));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {counters.map(([key, value]) => (
          <Stat key={key}>
            <StatLabel>{t(`outbox.stats.${key}`)}</StatLabel>
            <StatValue>{value}</StatValue>
          </Stat>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-base font-medium">
          {t('outbox.deadLetters')}
        </h2>
        {canManage && stats.deadLetters > 0 && (
          <>
            <ConfirmButton
              title={t('outbox.requeueAllTitle')}
              description={t('outbox.requeueAllDescription', {
                count: stats.deadLetters,
              })}
              confirm={t('outbox.requeueAll')}
              onConfirm={async () =>
                requeued((await requeue.mutateAsync(undefined)).requeued)
              }
            >
              {t('outbox.requeueAll')}
            </ConfirmButton>
            <ConfirmButton
              variant="destructive"
              title={t('outbox.purgeAllTitle')}
              description={t('outbox.purgeAllDescription', {
                count: stats.deadLetters,
              })}
              confirm={t('outbox.purgeAll')}
              onConfirm={async () =>
                purged((await purge.mutateAsync(undefined)).purged)
              }
            >
              {t('outbox.purgeAll')}
            </ConfirmButton>
          </>
        )}
      </div>
      {deadLetters.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('outbox.empty')}</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('outbox.topic')}</TableHead>
                <TableHead>{t('outbox.reason')}</TableHead>
                <TableHead className="text-end">
                  {t('outbox.attempts')}
                </TableHead>
                <TableHead>{t('outbox.lastError')}</TableHead>
                <TableHead>{t('outbox.failedAt')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('outbox.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deadLetters.map((letter) => (
                <TableRow key={letter.id}>
                  <TableCell className="font-mono text-xs">
                    {letter.topic}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {t(`outbox.reasons.${letter.reason}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {letter.attempts}
                  </TableCell>
                  {/* The engine's error text: remote, shown as text. */}
                  <TableCell className="max-w-md break-words whitespace-normal text-xs">
                    {letter.lastError}
                  </TableCell>
                  <TableCell>
                    {formatDateTime(new Date(letter.failedAt).toISOString())}
                  </TableCell>
                  <TableCell className="text-end">
                    {canManage && (
                      <div className="flex justify-end gap-2">
                        <ConfirmButton
                          size="sm"
                          title={t('outbox.requeueOneTitle')}
                          description={t('outbox.requeueOneDescription', {
                            topic: letter.topic,
                          })}
                          confirm={t('outbox.requeue')}
                          onConfirm={async () =>
                            requeued(
                              (await requeue.mutateAsync([letter.id])).requeued,
                            )
                          }
                        >
                          {t('outbox.requeue')}
                        </ConfirmButton>
                        <ConfirmButton
                          size="sm"
                          variant="destructive"
                          title={t('outbox.purgeOneTitle')}
                          description={t('outbox.purgeOneDescription', {
                            topic: letter.topic,
                          })}
                          confirm={t('outbox.purge')}
                          onConfirm={async () =>
                            purged(
                              (await purge.mutateAsync([letter.id])).purged,
                            )
                          }
                        >
                          {t('outbox.purge')}
                        </ConfirmButton>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {stats.deadLetters > deadLetters.length && (
        <p className="text-xs text-muted-foreground">
          {t('outbox.latest', { shown: deadLetters.length })}
        </p>
      )}
    </div>
  );
}
