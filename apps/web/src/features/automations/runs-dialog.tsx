import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { runsQuery, type AutomationRule } from './api';

/** A rule's latest runs: what each did, or why it failed. */
export function RunsDialog(props: {
  rule: AutomationRule;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('automations');
  const format = useDateTimeFormat();
  const runs = useQuery(runsQuery(props.rule.id));
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('runsTitle', { name: props.rule.name })}</DialogTitle>
          <DialogDescription>{t('runsDescription')}</DialogDescription>
        </DialogHeader>
        {runs.isPending && <Skeleton className="h-24 w-full" aria-busy />}
        {runs.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(runs.error)}
          </p>
        )}
        {runs.isSuccess &&
          (runs.data.items.length === 0 ? (
            <EmptyState title={t('noRuns')} />
          ) : (
            <ul className="flex flex-col gap-2">
              {runs.data.items.map((run) => (
                <li key={run.id} className="rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        run.status === 'failed' ? 'destructive' : 'outline'
                      }
                    >
                      {t(`run.${run.status}`)}
                    </Badge>
                    <span className="text-muted-foreground">
                      {format(run.createdAt)}
                    </span>
                    <span className="font-mono text-xs">{run.recordId}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('version', { version: run.ruleVersion })}
                    </span>
                  </div>
                  {run.error && (
                    <p className="mt-1 text-destructive">{run.error}</p>
                  )}
                  <ul className="mt-1 text-muted-foreground">
                    {run.actions.map((action, index) => (
                      <li key={index}>
                        {t(`action.${action.type}`)}: {action.detail}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ))}
      </DialogContent>
    </Dialog>
  );
}
