import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Switch } from '@nestjs-monorepo-template/ui/components/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { EllipsisIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TransferStatus } from '@/features/transfer/transfer-status';
import { useDateTimeFormat } from '@/lib/date-time';
import {
  reportsQuery,
  useDeleteReport,
  useRunReport,
  useUpdateReport,
  type Report,
} from './api';
import { ReportDialog } from './report-dialog';
import { describeSchedule } from './schedule';

/**
 * The user's scheduled reports (docs/reports.md): each an export run for them
 * on a schedule and mailed. Turn one off and on, run it now (its transfer
 * shown as it goes), edit it, delete it. A report is its owner's: nobody
 * else's are listed.
 */
export function ReportsPage() {
  const { t, i18n } = useTranslation('reports');
  const date = useDateTimeFormat();
  const list = useQuery(reportsQuery);
  const update = useUpdateReport();
  const remove = useDeleteReport();
  const run = useRunReport();
  const [editing, setEditing] = useState<Report | 'new'>();
  const [deleting, setDeleting] = useState<Report>();
  const [watching, setWatching] = useState<{ name: string; id: string }>();

  const runNow = (report: Report) =>
    run.mutate(report.id, {
      onSuccess: (started) => {
        toast.success(t('run.started', { name: report.name }));
        setWatching({ name: report.name, id: started.id });
      },
    });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-medium">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <PlusIcon />
          {t('create')}
        </Button>
      </div>
      {list.isPending ? (
        <Skeleton className="h-32 w-full" aria-busy />
      ) : list.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          <span className="text-destructive">{t('error')}</span>
          <Button size="sm" variant="outline" onClick={() => list.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : list.data.items.length === 0 ? (
        <p
          role="status"
          className="rounded-md border p-8 text-center text-sm text-muted-foreground"
        >
          {t('empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table aria-label={t('title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.schedule')}</TableHead>
                <TableHead>{t('columns.nextRun')}</TableHead>
                <TableHead>{t('columns.lastRun')}</TableHead>
                <TableHead>{t('columns.active')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('columns.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((report) => (
                <TableRow key={report.id}>
                  <TableCell>
                    <div className="font-medium">{report.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {report.exporter} · {t(`formats.${report.format}`)} ·{' '}
                      {t('recipients', { count: report.recipients.length })}
                    </div>
                  </TableCell>
                  <TableCell>
                    {describeSchedule(report.schedule, t, i18n.language)}
                    <div className="text-xs text-muted-foreground">
                      {report.timezone}
                    </div>
                  </TableCell>
                  <TableCell>
                    {report.active ? date(report.nextRunAt) : '—'}
                  </TableCell>
                  <TableCell>
                    {report.lastStatus && report.lastTransferId ? (
                      <button
                        type="button"
                        className="cursor-pointer"
                        onClick={() =>
                          setWatching({
                            name: report.name,
                            id: report.lastTransferId!,
                          })
                        }
                      >
                        <Badge
                          variant={
                            report.lastStatus === 'failed'
                              ? 'destructive'
                              : 'outline'
                          }
                        >
                          {t(`lastStatus.${report.lastStatus}`)}
                        </Badge>
                      </button>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('never')}
                      </span>
                    )}
                    {report.lastRunAt && (
                      <div className="text-xs text-muted-foreground">
                        {date(report.lastRunAt)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={t('toggle', { name: report.name })}
                      checked={report.active}
                      disabled={update.isPending}
                      onCheckedChange={(active) =>
                        update.mutate({ id: report.id, body: { active } })
                      }
                    />
                  </TableCell>
                  <TableCell className="text-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            aria-label={t('actions.label', {
                              name: report.name,
                            })}
                            variant="ghost"
                            size="icon-sm"
                          />
                        }
                      >
                        <EllipsisIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={run.isPending}
                          onClick={() => runNow(report)}
                        >
                          {t('actions.run')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditing(report)}>
                          {t('actions.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleting(report)}
                        >
                          {t('actions.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editing && (
        <ReportDialog
          // A fresh form per report.
          key={editing === 'new' ? 'new' : editing.id}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          report={editing === 'new' ? undefined : editing}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={t('delete.title')}
        description={t('delete.description', { name: deleting?.name })}
        confirm={t('actions.delete')}
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(t('delete.done', { name: deleting.name }));
        }}
      />
      <Dialog
        open={watching !== undefined}
        onOpenChange={(open) => {
          if (!open) setWatching(undefined);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('run.title', { name: watching?.name })}
            </DialogTitle>
            <DialogDescription>{t('run.description')}</DialogDescription>
          </DialogHeader>
          {watching && <TransferStatus id={watching.id} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWatching(undefined)}>
              {t('run.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
