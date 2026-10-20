import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
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
import { opsQueuesQuery, useRetryFailed } from './queries';
import type { QueueCounts } from './types';

const states = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
] as const satisfies readonly (keyof QueueCounts)[];

/** The background job queues: counts by state, the latest failures, retry. */
export function QueuesPanel() {
  const { t } = useTranslation('ops');
  const queues = useQuery(opsQueuesQuery);
  const retry = useRetryFailed();
  const canManage = useCan('Ops.manage');
  if (queues.isPending) {
    return <Spinner />;
  }
  if (queues.isError) {
    return <FormAlert message={errorMessage(queues.error)} />;
  }
  if (queues.data.items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('queues.empty')}</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('queues.name')}</TableHead>
              {states.map((state) => (
                <TableHead key={state} className="text-end">
                  {t(`queues.states.${state}`)}
                </TableHead>
              ))}
              <TableHead>
                <span className="sr-only">{t('queues.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queues.data.items.map((queue) => (
              <TableRow key={queue.name}>
                <TableCell className="font-mono text-xs">
                  {queue.name}
                  {queue.paused && (
                    <Badge variant="outline" className="ms-2">
                      {t('queues.paused')}
                    </Badge>
                  )}
                </TableCell>
                {states.map((state) => (
                  <TableCell key={state} className="text-end tabular-nums">
                    {queue.counts[state]}
                  </TableCell>
                ))}
                <TableCell className="text-end">
                  {canManage && queue.counts.failed > 0 && (
                    <ConfirmButton
                      size="sm"
                      title={t('queues.retryTitle', { name: queue.name })}
                      description={t('queues.retryDescription', {
                        count: queue.counts.failed,
                      })}
                      confirm={t('queues.retry')}
                      onConfirm={async () => {
                        const { retried } = await retry.mutateAsync(queue.name);
                        toast.success(t('queues.retried', { count: retried }));
                      }}
                    >
                      {t('queues.retry')}
                    </ConfirmButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {queues.data.items
        .filter((queue) => queue.recentFailures.length > 0)
        .map((queue) => (
          <section key={queue.name} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {t('queues.failures', { name: queue.name })}
            </h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('queues.job')}</TableHead>
                    <TableHead className="text-end">
                      {t('queues.attempts')}
                    </TableHead>
                    <TableHead>{t('queues.reason')}</TableHead>
                    <TableHead>{t('queues.failedAt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.recentFailures.map((job) => (
                    <TableRow key={String(job.id)}>
                      <TableCell className="font-mono text-xs">
                        {job.name}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {job.attempts}
                      </TableCell>
                      {/* The job's error text: remote, shown as text. */}
                      <TableCell className="max-w-md break-words whitespace-normal text-xs">
                        {job.reason}
                      </TableCell>
                      <TableCell>{formatDateTime(job.failedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ))}
    </div>
  );
}
