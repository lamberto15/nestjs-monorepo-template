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
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** A button whose action is asked about first (shadcn's AlertDialog). */
export function ConfirmButton(props: {
  children: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirm: ReactNode;
  onConfirm: () => Promise<unknown>;
  variant?: 'outline' | 'destructive' | 'ghost';
  size?: 'default' | 'sm';
  disabled?: boolean;
  /** The trigger's accessible name, when its text alone is ambiguous (one per row). */
  label?: string;
  /** Called when the dialog opens: refresh what the question is about. */
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={props.variant ?? 'outline'}
        size={props.size}
        disabled={props.disabled}
        aria-label={props.label}
        onClick={() => {
          setOpen(true);
          props.onOpen?.();
        }}
      >
        {props.children}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{props.title}</AlertDialogTitle>
            <AlertDialogDescription>{props.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('account.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await props.onConfirm();
                  setOpen(false);
                } catch {
                  // The action failed: its own handler (or the global one)
                  // told the user, and the dialog stays open to try again.
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
    </>
  );
}
