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
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { CheckIcon, CopyIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useOnSessionChange } from '@/hooks/use-on-session-change';

/**
 * A signing secret, shown once. Open while `secret` is set; `onClose` must `reset()` the
 * mutation that made it. The dialog cannot be dismissed by a click outside or
 * Escape by accident (the secret would be lost): only "I have copied it".
 */
export function SecretDialog(props: {
  secret: string | undefined;
  title: string;
  /** What to do with it, when not the endpoint wording (a receiver verifies). */
  usage?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('webhooks');
  const [copied, setCopied] = useState(false);
  const close = () => {
    setCopied(false);
    props.onClose();
  };
  // Shown to the session that made it: one that changes under the dialog
  // (signed out, another tenant, in this tab or another) never sees the secret.
  useOnSessionChange(close);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.secret ?? '');
      setCopied(true);
      toast.success(t('secret.copied'));
    } catch {
      toast.error(t('secret.copyFailed'));
    }
  };
  return (
    <Dialog
      open={props.secret !== undefined}
      // Only "done" closes it: a stray click or Escape would lose the secret.
      onOpenChange={() => undefined}
      disablePointerDismissal
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            {props.usage ?? t('secret.usage')}
          </DialogDescription>
        </DialogHeader>
        <Alert>
          <TriangleAlertIcon />
          <AlertDescription>{t('secret.warning')}</AlertDescription>
        </Alert>
        <div className="flex items-center gap-2">
          <code
            aria-label={t('secret.label')}
            className="min-w-0 flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all select-all"
          >
            {props.secret}
          </code>
          <Button type="button" variant="outline" onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {t('secret.copy')}
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t('secret.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
