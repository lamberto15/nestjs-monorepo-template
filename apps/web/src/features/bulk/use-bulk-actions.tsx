import { ActionBarItem } from '@nestjs-monorepo-template/ui/components/action-bar';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { BulkAction, BulkPath } from './api';
import type { BulkContext } from './types';
import { useBulkRun } from './use-bulk-run';

/** One button of the selection's action bar. */
export interface BulkActionSpec {
  action: BulkAction;
  /** The button's text. */
  label: string;
  icon?: LucideIcon;
  /** A destructive action asks first (its texts: `bulk:confirm.<action>`). */
  confirm?: boolean;
  /** What the action takes (`update`: the PATCH body). */
  input?: Record<string, unknown>;
}

/**
 * The actions of a list's selection, for `ListPage`'s `bulkActions`: an
 * `ActionBarItem` per action, a confirmation for the destructive ones, and
 * the run's dialog (`useBulkRun`). The dialogs belong to the page, not the
 * bar, so they outlive the selection: render `dialogs` next to the list.
 */
export function useBulkActions(path: BulkPath, actions: BulkActionSpec[]) {
  const { t } = useTranslation('bulk');
  const run = useBulkRun(path);
  const [asking, setAsking] = useState<{
    spec: BulkActionSpec;
    context: BulkContext;
  }>();
  const { start } = run;

  const go = useCallback(
    (spec: BulkActionSpec, context: BulkContext) =>
      start(
        {
          action: spec.action,
          selection: context.selection,
          ...(spec.input && { input: spec.input }),
        },
        context.clear,
      ),
    [start],
  );

  const render = useCallback(
    (context: BulkContext): ReactNode =>
      actions.map((spec) => (
        <ActionBarItem
          key={spec.action}
          variant={spec.confirm ? 'destructive' : 'secondary'}
          onSelect={(event) => {
            // The bar stays (with its selection) until the run ends.
            event.preventDefault();
            if (spec.confirm) {
              setAsking({ spec, context });
            } else {
              go(spec, context);
            }
          }}
        >
          {spec.icon && <spec.icon />}
          {spec.label}
        </ActionBarItem>
      )),
    // `actions` is the caller's; keep it stable (useMemo).
    [actions, go],
  );

  const dialogs = (
    <>
      <ConfirmDialog
        open={asking !== undefined}
        onOpenChange={(open) => {
          if (!open) setAsking(undefined);
        }}
        title={
          asking
            ? t(`confirm.${asking.spec.action}.title`, {
                count: asking.context.count,
              })
            : ''
        }
        description={
          asking
            ? t(`confirm.${asking.spec.action}.description`, {
                count: asking.context.count,
              })
            : ''
        }
        confirm={asking?.spec.label ?? ''}
        onConfirm={async () => {
          if (asking) go(asking.spec, asking.context);
        }}
      />
      {run.dialog}
    </>
  );

  return { render, dialogs };
}
