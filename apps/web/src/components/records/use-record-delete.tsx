import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { recordKeys, useInvalidateRecords } from '@/lib/records';

/**
 * Delete (to the recycle bin) with a confirmation, then a toast with an
 * "Undo" that restores. Returns `ask(record)`, which opens the confirmation,
 * and the `dialog` to render once; `restore(record)` is for a bin's rows.
 * The feature supplies the two calls and its texts:
 *
 *   const { ask, dialog } = useRecordDelete({ path: '/v1/notes', remove, restore, texts });
 */
export function useRecordDelete<T>(options: {
  /** The feature's list route: its lists and records are refreshed. */
  path: string;
  remove: (record: T) => Promise<unknown>;
  restore: (record: T) => Promise<unknown>;
  texts: {
    title: string;
    description: string;
    confirm: string;
    deleted: string;
    undo: string;
    restored: string;
  };
  /** After the record is deleted (a detail page leaves for the list). */
  onDeleted?: (record: T) => void;
  /** After a restore, whether from the toast or the bin. */
  onRestored?: (record: T) => void;
}) {
  const { path, remove, restore, texts, onDeleted, onRestored } = options;
  const invalidate = useInvalidateRecords(path);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<{ record: T } | null>(null);
  // Mutations, so a failure reaches the global handler (lib/errors.ts).
  const removing = useMutation({ mutationFn: remove });
  const restoring = useMutation({ mutationFn: restore });

  // `ask` and `restore` are stable, so a table's columns built on them are
  // not rebuilt at every render; they read the latest options from here.
  const latest = useRef({ restoring, invalidate, texts, onRestored });
  useEffect(() => {
    latest.current = { restoring, invalidate, texts, onRestored };
  });
  const restoreRecord = useCallback(async (record: T) => {
    const { restoring, invalidate, texts, onRestored } = latest.current;
    await restoring.mutateAsync(record);
    await invalidate();
    toast.success(texts.restored);
    onRestored?.(record);
  }, []);
  const ask = useCallback((record: T) => setTarget({ record }), []);

  const dialog: ReactNode = (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && setTarget(null)}
      title={texts.title}
      description={texts.description}
      confirm={texts.confirm}
      onConfirm={async () => {
        if (!target) return;
        const { record } = target;
        await removing.mutateAsync(record);
        // The record is gone from its route: dropping its query (not
        // invalidating it) keeps a detail page still on screen from
        // refetching it into a 404 before it navigates away.
        queryClient.removeQueries({ queryKey: recordKeys.details(path) });
        await queryClient.invalidateQueries({
          queryKey: recordKeys.lists(path),
        });
        toast(texts.deleted, {
          action: {
            label: texts.undo,
            // A failed restore is the global handler's toast.
            onClick: () => void restoreRecord(record).catch(() => undefined),
          },
        });
        onDeleted?.(record);
      }}
    />
  );

  return {
    ask,
    restore: restoreRecord,
    dialog,
  };
}
