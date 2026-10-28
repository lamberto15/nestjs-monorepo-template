import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useInfiniteQuery } from '@tanstack/react-query';
import { HistoryIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useCan } from '@/lib/features';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { rulesQuery, useRuleAction, type AutomationRule } from './api';
import { RuleDialog } from './rule-dialog';
import { RunsDialog } from './runs-dialog';

const STATUS_VARIANT = {
  active: 'default',
  draft: 'outline',
  disabled: 'secondary',
} as const;

/**
 * Automation rules (docs/automations.md): the tenant's own "when a record
 * is created or changed and matches, do this". A rule is built and
 * simulated in a dialog, saved as a draft, then activated: it runs as the
 * one who activates it. Its runs show what it did, or why it failed.
 */
export function AutomationsPage() {
  const { t } = useTranslation('automations');
  const format = useDateTimeFormat();
  const manage = useCan('AutomationRule.manage');
  const list = useInfiniteQuery({
    ...rulesQuery(),
    meta: { errorToast: false },
  });
  const act = useRuleAction();
  const [editing, setEditing] = useState<AutomationRule | 'new'>();
  const [runsOf, setRunsOf] = useState<AutomationRule>();
  const rules = list.data?.pages.flatMap((page) => page.items) ?? [];

  const run = (
    rule: AutomationRule,
    action: 'activate' | 'disable' | 'delete',
  ) =>
    act.mutate(
      { id: rule.id, action },
      {
        onSuccess: () =>
          toast.success(t(`done.${action}`, { name: rule.name })),
      },
    );

  return (
    <Page>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          manage && (
            <Button onClick={() => setEditing('new')}>
              <PlusIcon />
              {t('new')}
            </Button>
          )
        }
      />
      {list.isPending && <Skeleton className="h-40 w-full" aria-busy />}
      {list.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(list.error)}
        </p>
      )}
      {list.isSuccess &&
        (rules.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.name')}</TableHead>
                  <TableHead>{t('columns.subject')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead>{t('columns.lastRun')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell className="font-medium">
                      {rule.name}
                      <span className="ms-2 text-xs text-muted-foreground">
                        {t('version', { version: rule.version })}
                      </span>
                    </TableCell>
                    <TableCell>
                      {rule.subject} · {t(`trigger.${rule.trigger}`)}
                      {rule.field && ` (${rule.field})`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[rule.status]}>
                        {t(`status.${rule.status}`)}
                      </Badge>
                      {rule.disabledReason && (
                        <span className="ms-2 text-xs text-muted-foreground">
                          {t(`reason.${rule.disabledReason}`, {
                            defaultValue: rule.disabledReason,
                          })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {rule.lastRunAt
                        ? `${format(rule.lastRunAt)} · ${t(`run.${rule.lastStatus ?? 'succeeded'}`)}`
                        : t('never')}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('runsOf', { name: rule.name })}
                          onClick={() => setRunsOf(rule)}
                        >
                          <HistoryIcon />
                          {t('runs')}
                        </Button>
                        {manage && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={t('edit', { name: rule.name })}
                              onClick={() => setEditing(rule)}
                            >
                              <PencilIcon />
                              {t('editButton')}
                            </Button>
                            {rule.status === 'active' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={act.isPending}
                                onClick={() => run(rule, 'disable')}
                              >
                                {t('disable')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                disabled={act.isPending}
                                onClick={() => run(rule, 'activate')}
                              >
                                {t('activate')}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={act.isPending}
                              aria-label={t('delete', { name: rule.name })}
                              onClick={() => run(rule, 'delete')}
                            >
                              {t('deleteButton')}
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage && <Spinner />}
          {t('more')}
        </Button>
      )}
      {/* Mounted only while open: a cancelled draft doesn't come back. */}
      {editing && (
        <RuleDialog
          rule={editing === 'new' ? undefined : editing}
          onOpenChange={(open) => !open && setEditing(undefined)}
        />
      )}
      {runsOf && (
        <RunsDialog
          rule={runsOf}
          onOpenChange={(open) => !open && setRunsOf(undefined)}
        />
      )}
    </Page>
  );
}
