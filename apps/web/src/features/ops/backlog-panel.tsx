import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Checkbox } from '@nestjs-monorepo-template/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';
import {
  useBacklogAction,
  useBacklogPreview,
  type BacklogScope,
  type BacklogTarget,
} from './queries';

/**
 * Scoped recovery of a notification storm (docs/notifications.md,
 * "Recovering a backlog"): count the outbox and mail backlog of one tenant,
 * or of every tenant when asked, narrowed by notification type and mail
 * class; then discard or retry it. The API never discards a mandatory
 * notification or essential mail; every change is audited.
 */
export function BacklogPanel() {
  const { t } = useTranslation('ops');
  const id = useId();
  const canManage = useCan('Ops.manage');
  const [tenantId, setTenantId] = useState('');
  const [global, setGlobal] = useState(false);
  const [type, setType] = useState('');
  const [template, setTemplate] = useState('');
  const preview = useBacklogPreview();
  const discard = useBacklogAction('discard');
  const retry = useBacklogAction('retry');
  // What was counted: the actions apply to that scope, never an edited one.
  const [counted, setCounted] = useState<BacklogScope | null>(null);

  const scope = (): BacklogScope => ({
    ...(global ? { global: true } : { tenantId: tenantId.trim() }),
    ...(type.trim() ? { type: type.trim() } : {}),
    ...(template.trim() ? { template: template.trim() } : {}),
  });
  const count = async () => {
    const next = scope();
    setCounted(null);
    await preview.mutateAsync(next).then(
      () => setCounted(next),
      () => undefined,
    );
  };
  const act = async (action: 'discard' | 'retry', target: BacklogTarget) => {
    if (!counted) return;
    const done = await (action === 'discard' ? discard : retry).mutateAsync({
      target,
      scope: counted,
    });
    toast.success(t(`backlog.done.${action}`, { total: done }));
    await preview.mutateAsync(counted).catch(() => undefined);
  };

  const result = counted ? preview.data : undefined;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t('backlog.intro')}</p>
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-80">
          <FieldLabel htmlFor={`${id}-tenant`}>
            {t('backlog.tenant')}
          </FieldLabel>
          <Input
            id={`${id}-tenant`}
            value={tenantId}
            disabled={global}
            onChange={(event) => setTenantId(event.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </Field>
        <Field orientation="horizontal" className="w-auto">
          <Checkbox
            id={`${id}-global`}
            checked={global}
            onCheckedChange={(checked) => setGlobal(!!checked)}
          />
          <FieldLabel htmlFor={`${id}-global`}>
            {t('backlog.global')}
          </FieldLabel>
        </Field>
        <Field className="w-56">
          <FieldLabel htmlFor={`${id}-type`}>{t('backlog.type')}</FieldLabel>
          <Input
            id={`${id}-type`}
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="note.published"
          />
        </Field>
        <Field className="w-56">
          <FieldLabel htmlFor={`${id}-template`}>
            {t('backlog.template')}
          </FieldLabel>
          <Input
            id={`${id}-template`}
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            placeholder="NotificationMail"
          />
        </Field>
        <Button
          onClick={count}
          disabled={(!global && !tenantId.trim()) || preview.isPending}
        >
          {t('backlog.count')}
        </Button>
      </div>
      <FieldDescription>{t('backlog.scopeHint')}</FieldDescription>
      {preview.isError && <FormAlert message={errorMessage(preview.error)} />}
      {result && (
        <>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {t('backlog.outbox', {
                pending: result.outbox.pending.total,
                dead: result.outbox.deadLetters.total,
                leased: result.outbox.leased,
              })}
            </h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('backlog.kind')}</TableHead>
                    <TableHead>{t('outbox.topic')}</TableHead>
                    <TableHead>{t('backlog.type')}</TableHead>
                    <TableHead className="text-end">
                      {t('backlog.number')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(
                    [
                      ['pending', result.outbox.pending.groups],
                      ['deadLetters', result.outbox.deadLetters.groups],
                    ] as const
                  ).flatMap(([kind, groups]) =>
                    groups.map((group) => (
                      <TableRow key={`${kind}-${group.topic}-${group.type}`}>
                        <TableCell>{t(`backlog.kinds.${kind}`)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {group.topic}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {group.type}
                          {group.mandatory && (
                            <Badge variant="outline" className="ms-2">
                              {t('backlog.kept')}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {group.count}
                        </TableCell>
                      </TableRow>
                    )),
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t('backlog.mail')}</h3>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('backlog.state')}</TableHead>
                    <TableHead>{t('backlog.template')}</TableHead>
                    <TableHead className="text-end">
                      {t('backlog.number')}
                    </TableHead>
                    <TableHead className="text-end">
                      {t('backlog.essential')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.mail.groups.map((group) => (
                    <TableRow key={`${group.state}-${group.template}`}>
                      <TableCell>{group.state}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {group.template}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {group.count}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {group.essential}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {result.mail.capped && (
              <p className="text-sm text-muted-foreground">
                {t('backlog.capped')}
              </p>
            )}
          </section>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {(['outbox', 'mail'] as const).map((target) => (
                <ConfirmButton
                  key={`discard-${target}`}
                  variant="destructive"
                  allowInMaintenance
                  title={t(`backlog.discardTitle.${target}`)}
                  description={t('backlog.discardDescription')}
                  confirm={t(`backlog.discard.${target}`)}
                  onConfirm={() => act('discard', target)}
                >
                  {t(`backlog.discard.${target}`)}
                </ConfirmButton>
              ))}
              {(['outbox', 'mail'] as const).map((target) => (
                <ConfirmButton
                  key={`retry-${target}`}
                  variant="outline"
                  allowInMaintenance
                  title={t(`backlog.retryTitle.${target}`)}
                  description={t('backlog.retryDescription')}
                  confirm={t(`backlog.retry.${target}`)}
                  onConfirm={() => act('retry', target)}
                >
                  {t(`backlog.retry.${target}`)}
                </ConfirmButton>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
