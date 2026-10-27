import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
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
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowLeftIcon, CopyIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useDateTimeFormat } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';
import { SecretDialog } from './secret-dialog';
import { SenderFormDialog, type SenderValues } from './sender-form-dialog';
import {
  sendersQuery,
  useCreateSender,
  useDeleteSender,
  useRotateSenderSecret,
  useUpdateSender,
  type Sender,
} from './sender-queries';

/** The URL a sender POSTs to: the API's origin is the web app's (same-origin). */
const receiverUrl = (sender: Sender) =>
  `${window.location.origin}${sender.path}`;

/**
 * The tenant's incoming webhook senders: who may POST to
 * `/v1/webhooks/tenants/{tenantId}/senders/{name}`. Creating one, or rotating
 * its secret, shows the new secret once.
 */
export function SendersPage() {
  const { t } = useTranslation('webhooks');
  const format = useDateTimeFormat();
  const list = useQuery(sendersQuery);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Sender>();
  const [error, setError] = useState<string>();
  const create = useCreateSender();
  const update = useUpdateSender();
  const rotate = useRotateSenderSecret();
  const remove = useDeleteSender();
  const copy = async (sender: Sender) => {
    try {
      await navigator.clipboard.writeText(receiverUrl(sender));
      toast.success(t('senders.urlCopied'));
    } catch {
      toast.error(t('secret.copyFailed'));
    }
  };
  return (
    <Page>
      <Link
        to="/webhooks"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'self-start',
        )}
      >
        <ArrowLeftIcon className="rtl:rotate-180" />
        {t('senders.back')}
      </Link>
      <PageHeader
        title={t('senders.title')}
        description={t('senders.description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            {t('senders.create')}
          </Button>
        }
      />
      <FormAlert message={error} />
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <FormAlert message={errorMessage(list.error)} />
      ) : list.data.items.length ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('senders.columns.name')}</TableHead>
                <TableHead>{t('senders.columns.url')}</TableHead>
                <TableHead>{t('senders.columns.enabled')}</TableHead>
                <TableHead>
                  <span className="sr-only">
                    {t('senders.columns.actions')}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((sender) => {
                const graceEnds = sender.previousSecretExpiresAt;
                return (
                  <TableRow key={sender.id}>
                    <TableCell className="align-top font-medium">
                      {sender.name}
                      {sender.description && (
                        <p className="text-xs font-normal text-muted-foreground">
                          {sender.description}
                        </p>
                      )}
                      {graceEnds && Date.parse(graceEnds) > Date.now() && (
                        <Badge variant="outline" className="mt-1">
                          {t('senders.oldSecretUntil', {
                            date: format(graceEnds),
                          })}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-md align-top">
                      <div className="flex items-start gap-2">
                        <code className="min-w-0 flex-1 rounded bg-muted px-1 text-xs break-all select-all">
                          {receiverUrl(sender)}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('senders.copyUrl', {
                            name: sender.name,
                          })}
                          onClick={() => copy(sender)}
                        >
                          <CopyIcon />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Switch
                        aria-label={t('senders.toggle', { name: sender.name })}
                        checked={sender.enabled}
                        disabled={update.isPending}
                        onCheckedChange={async (enabled) => {
                          setError(undefined);
                          try {
                            await update.mutateAsync({
                              id: sender.id,
                              changes: { enabled },
                            });
                            toast.success(
                              t(
                                enabled
                                  ? 'senders.switchedOn'
                                  : 'senders.switchedOff',
                              ),
                            );
                          } catch (caught) {
                            setError(errorMessage(caught));
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={t('senders.editLabel', {
                            name: sender.name,
                          })}
                          onClick={() => setEditing(sender)}
                        >
                          {t('detail.edit')}
                        </Button>
                        <ConfirmButton
                          size="sm"
                          label={t('senders.rotateLabel', {
                            name: sender.name,
                          })}
                          title={t('senders.rotateTitle')}
                          description={t('senders.rotateDescription')}
                          confirm={t('detail.rotateConfirm')}
                          onConfirm={() => rotate.mutateAsync(sender.id)}
                        >
                          {t('detail.rotate')}
                        </ConfirmButton>
                        <ConfirmButton
                          size="sm"
                          variant="destructive"
                          label={t('senders.deleteLabel', {
                            name: sender.name,
                          })}
                          title={t('senders.deleteTitle')}
                          description={t('senders.deleteDescription')}
                          confirm={t('detail.deleteConfirm')}
                          onConfirm={async () => {
                            await remove.mutateAsync(sender.id);
                            toast.success(t('senders.deleted'));
                          }}
                        >
                          {t('detail.delete')}
                        </ConfirmButton>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState title={t('senders.empty')} />
      )}
      <SenderFormDialog
        open={creating}
        onOpenChange={setCreating}
        onSubmit={(values: SenderValues) =>
          create.mutateAsync({
            name: values.name,
            // An empty description is a 400: leave it out.
            ...(values.description && { description: values.description }),
          })
        }
      />
      {editing && (
        <SenderFormDialog
          open
          onOpenChange={(open) => !open && setEditing(undefined)}
          sender={editing}
          onSubmit={async (values: SenderValues) => {
            await update.mutateAsync({
              id: editing.id,
              // null clears it; an empty string is a 400.
              changes: { description: values.description || null },
            });
            toast.success(t('senders.saved'));
          }}
        />
      )}
      <SecretDialog
        secret={create.data?.secret ?? rotate.data?.secret}
        title={t(create.data ? 'secret.createdTitle' : 'secret.rotatedTitle')}
        usage={t('senders.secretUsage')}
        onClose={() => {
          create.reset();
          rotate.reset();
        }}
      />
    </Page>
  );
}
