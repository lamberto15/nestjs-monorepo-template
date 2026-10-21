import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@nestjs-monorepo-template/ui/components/alert-dialog';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useWritesPaused } from '@/lib/mode';

/**
 * A confirmation the caller opens and closes (shadcn's AlertDialog): for an
 * action that starts from a menu item, where ConfirmButton has no button to
 * click. `onConfirm` failing keeps the dialog open. The confirming button is
 * disabled while the API refuses writes (read-only or maintenance mode),
 * unless the action's route stays open in both (`allowInMaintenance`).
 */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirm: ReactNode;
  onConfirm: () => Promise<unknown>;
  /** The action's route answers in read-only and maintenance mode too. */
  allowInMaintenance?: boolean;
}) {
  const { t } = useTranslation();
  const paused = useWritesPaused() && !props.allowInMaintenance;
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('account.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || paused}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
                props.onOpenChange(false);
              } catch {
                // The global handler told the user; the dialog stays open.
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />}
            {props.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
