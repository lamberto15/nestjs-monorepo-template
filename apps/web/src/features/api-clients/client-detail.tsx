import { useQuery } from '@tanstack/react-query';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { cn } from 'cn';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { formatDateTime } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { useFeature } from '@/lib/features';
import { z } from '@/lib/zod';
import {
  clientsQuery,
  isExpired,
  useRevokeKey,
  useRotateKey,
  useUpdateClient,
  type Client,
} from './queries';
import { SecretDialog } from './secret-dialog';

const graces = ['0', '3600', '86400', '604800'] as const;

/** One client: its keys (rotate, revoke), quota, state, last use. */
export function ClientDetail(props: { id: string }) {
  const { t } = useTranslation('api-clients');
  const list = useQuery(clientsQuery);
  const client = list.data?.items.find((item) => item.id === props.id);
  const hasUsage = useFeature('usage');
  if (list.isPending) {
    return <Spinner />;
  }
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Link
        to="/api-clients"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'self-start',
        )}
      >
        <ArrowLeftIcon className="rtl:rotate-180" />
        {t('detail.back')}
      </Link>
      {client ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-medium">{client.name}</h1>
            <Badge variant={client.active ? 'default' : 'outline'}>
              {t(`status.${client.active ? 'active' : 'revoked'}`)}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {t('detail.created', { date: formatDateTime(client.createdAt) })}
            </span>
            {hasUsage && (
              <Link
                to="/api-clients/usage"
                search={{ client: client.id, days: '30' }}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'ms-auto',
                )}
              >
                {t('detail.viewUsage')}
              </Link>
            )}
          </div>
          <KeysSection client={client} />
          <QuotaSection client={client} />
          <StateSection client={client} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('detail.notFound')}</p>
      )}
    </div>
  );
}

function KeysSection({ client }: { client: Client }) {
  const { t } = useTranslation('api-clients');
  const revoke = useRevokeKey(client.id);
  const rotate = useRotateKey(client.id);
  const [grace, setGrace] = useState<string>('0');
  const status = (key: Client['keys'][number]) =>
    key.revokedAt
      ? t('detail.keys.revokedAt', { date: formatDateTime(key.revokedAt) })
      : isExpired(key)
        ? t('detail.keys.expired')
        : t('detail.keys.active');
  return (
    <Section
      title={t('detail.keys.title')}
      description={t('detail.rotate.description')}
    >
      {client.keys.length ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('detail.keys.columns.key')}</TableHead>
                <TableHead>{t('detail.keys.columns.status')}</TableHead>
                <TableHead>{t('detail.keys.columns.created')}</TableHead>
                <TableHead>{t('detail.keys.columns.expires')}</TableHead>
                <TableHead>{t('detail.keys.columns.lastUsed')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {client.keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-mono text-xs">
                    {key.keyId}
                  </TableCell>
                  <TableCell>{status(key)}</TableCell>
                  <TableCell>{formatDateTime(key.createdAt)}</TableCell>
                  <TableCell>
                    {formatDateTime(key.expiresAt) || t('detail.keys.never')}
                  </TableCell>
                  <TableCell>
                    {formatDateTime(key.lastUsedAt) || t('detail.keys.never')}
                  </TableCell>
                  <TableCell className="text-end">
                    {!key.revokedAt && (
                      <ConfirmButton
                        variant="ghost"
                        size="sm"
                        title={t('detail.keys.revokeTitle')}
                        description={t('detail.keys.revokeDescription', {
                          keyId: key.keyId,
                        })}
                        confirm={t('detail.keys.revokeConfirm')}
                        onConfirm={async () => {
                          await revoke.mutateAsync(key.id);
                          toast.success(t('detail.keys.revokedToast'));
                        }}
                      >
                        {t('detail.keys.revoke')}
                      </ConfirmButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('detail.keys.empty')}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" id="grace-label">
            {t('detail.rotate.grace')}
          </label>
          <Select
            value={grace}
            onValueChange={(value) => setGrace(value ?? '0')}
            items={graces.map((value) => ({
              value,
              label: t(`detail.rotate.graces.${value}`),
            }))}
          >
            <SelectTrigger aria-labelledby="grace-label" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {graces.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`detail.rotate.graces.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ConfirmButton
          disabled={!client.active}
          title={t('detail.rotate.confirmTitle', { name: client.name })}
          description={t('detail.rotate.confirmDescription')}
          confirm={t('detail.rotate.submit')}
          onConfirm={() => rotate.mutateAsync(Number(grace))}
        >
          {t('detail.rotate.submit')}
        </ConfirmButton>
      </div>
      <SecretDialog
        secret={rotate.data?.key}
        title={t('secret.rotatedTitle', { name: client.name })}
        onClose={() => rotate.reset()}
      />
    </Section>
  );
}

function QuotaSection({ client }: { client: Client }) {
  const { t } = useTranslation('api-clients');
  const update = useUpdateClient(client.id);
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { dailyQuota: client.dailyQuota?.toString() ?? '' },
    validators: {
      onSubmit: z.object({
        dailyQuota: z
          .string()
          .trim()
          .refine((value) => value === '' || /^[1-9]\d{0,8}$/.test(value), {
            message: t('create.quotaInvalid'),
          }),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const quota = value.dailyQuota.trim();
        await update.mutateAsync({
          dailyQuota: quota ? Number(quota) : null,
        });
        toast.success(t('detail.quota.saved'));
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Section
      title={t('detail.quota.title')}
      description={t('detail.quota.description')}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <FormAlert message={error} />
          <form.AppField name="dailyQuota">
            {(field) => (
              <field.TextField
                label={t('detail.quota.label')}
                description={
                  client.dailyQuota === null
                    ? t('detail.quota.none')
                    : undefined
                }
              />
            )}
          </form.AppField>
          <div>
            <form.AppForm>
              <form.SubmitButton>{t('detail.quota.save')}</form.SubmitButton>
            </form.AppForm>
          </div>
        </FieldGroup>
      </form>
    </Section>
  );
}

function StateSection({ client }: { client: Client }) {
  const { t } = useTranslation('api-clients');
  const update = useUpdateClient(client.id);
  return (
    <Section
      title={t('detail.state.title')}
      description={t('detail.state.activeDescription')}
    >
      {client.active ? (
        <ConfirmButton
          variant="destructive"
          title={t('detail.state.revokeTitle', { name: client.name })}
          description={t('detail.state.revokeDescription')}
          confirm={t('detail.state.revokeConfirm')}
          onConfirm={async () => {
            await update.mutateAsync({ active: false });
            toast.success(t('detail.state.revoked'));
          }}
        >
          {t('detail.state.revoke')}
        </ConfirmButton>
      ) : (
        <div>
          <Button
            variant="outline"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { active: true },
                {
                  onSuccess: () => toast.success(t('detail.state.reactivated')),
                },
              )
            }
          >
            {t('detail.state.reactivate')}
          </Button>
        </div>
      )}
    </Section>
  );
}
