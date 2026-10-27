import { isApiError } from '@nestjs-monorepo-template/api-client';
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
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { rolesQuery } from '@/features/access/api';
import {
  draftOf,
  endInPast,
  grantsBody,
  isEnded,
  type GrantDraft,
} from '@/features/access/grants';
import { RoleGrantsPicker } from '@/features/access/pickers';
import { formatDateTime } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { useFeature } from '@/lib/features';
import { z } from '@/lib/zod';
import {
  clientQuery,
  isExpired,
  useDeleteClient,
  useRevokeKey,
  useRotateKey,
  useUpdateClient,
  type Client,
} from './queries';
import { cidrList, cidrProblems } from './cidr';
import { SecretDialog } from './secret-dialog';

const graces = ['0', '3600', '86400', '604800'] as const;

/**
 * One client, read on its own (`GET /v1/access/clients/{id}`): its keys
 * (rotate, revoke), roles, quota, state (revoke, delete), last use.
 */
export function ClientDetail(props: { id: string }) {
  const { t } = useTranslation('api-clients');
  // A 404 is this page's to say, not a toast's.
  const read = useQuery({
    ...clientQuery(props.id),
    meta: { errorToast: false },
  });
  const client = read.data;
  const hasUsage = useFeature('usage');
  if (read.isPending) {
    return <Spinner />;
  }
  const missing = isApiError(read.error) && read.error.status === 404;
  return (
    <Page width="narrow">
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
          <PageHeader
            title={client.name}
            description={t('detail.created', {
              date: formatDateTime(client.createdAt),
            })}
            badges={
              <Badge variant={client.active ? 'default' : 'outline'}>
                {t(`status.${client.active ? 'active' : 'revoked'}`)}
              </Badge>
            }
            actions={
              hasUsage && (
                <Link
                  to="/api-clients/usage"
                  search={{ client: client.id, days: 30 }}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('detail.viewUsage')}
                </Link>
              )
            }
          />
          <KeysSection client={client} />
          <RolesSection
            // Refetched after a change: a fresh draft.
            key={client.updatedAt}
            client={client}
          />
          <QuotaSection client={client} />
          <AllowlistSection
            // Refetched after a change: the saved (normalized) list.
            key={client.updatedAt}
            client={client}
          />
          <StateSection client={client} />
        </>
      ) : missing ? (
        <EmptyState title={t('detail.notFound')} />
      ) : (
        <FormAlert message={errorMessage(read.error)} />
      )}
    </Page>
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

/**
 * The client's roles, on top of what every client may do (the API's
 * clientPermissions), each until a date if wanted. The API refuses roles the
 * user couldn't grant. An ended grant isn't ticked (sent back without its
 * end, it would come back for good).
 */
function RolesSection({ client }: { client: Client }) {
  const { t } = useTranslation('api-clients');
  const roles = useQuery(rolesQuery);
  const update = useUpdateClient(client.id);
  const [grants, setGrants] = useState<GrantDraft>(() => draftOf(client.roles));
  const pastEnd = Object.values(grants).some((until) => endInPast(until));
  const ended = client.roles.filter((grant) => isEnded(grant));
  const names = new Map((roles.data ?? []).map((role) => [role.id, role.name]));
  return (
    <Section
      title={t('detail.roles.title')}
      description={t('detail.roles.description')}
    >
      {roles.isPending ? (
        <Spinner />
      ) : roles.isError ? (
        <FormAlert message={errorMessage(roles.error)} />
      ) : (
        <RoleGrantsPicker
          idPrefix="client"
          roles={roles.data}
          value={grants}
          onChange={setGrants}
          disabled={update.isPending}
        />
      )}
      {ended.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('detail.roles.ended', {
            roles: ended
              .map((grant) => names.get(grant.roleId) ?? grant.roleId)
              .join(', '),
          })}
        </p>
      )}
      <div>
        <Button
          disabled={update.isPending || pastEnd || !roles.isSuccess}
          // A refusal (a role the user can't grant) is the global toast.
          onClick={() =>
            update.mutate(grantsBody(grants), {
              onSuccess: () => toast.success(t('detail.roles.saved')),
            })
          }
        >
          {update.isPending && <Spinner />}
          {t('detail.roles.save')}
        </Button>
      </div>
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

/**
 * The addresses the client's keys may be used from, one per line (empty: any).
 * Entries are checked here for a friendly message; the API's `400 invalid_cidr`
 * (it is the authority) is shown on the same field.
 */
function AllowlistSection({ client }: { client: Client }) {
  const { t } = useTranslation('api-clients');
  const update = useUpdateClient(client.id, { errorToast: false });
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { allowedCidrs: client.allowedCidrs.join('\n') },
    validators: {
      onSubmit: ({ value }) => {
        const [first, ...more] = cidrProblems(value.allowedCidrs);
        if (!first) {
          return undefined;
        }
        const message = [first, ...more]
          .map((problem) =>
            t(
              problem.kind === 'prefix'
                ? 'detail.allowlist.prefix'
                : 'detail.allowlist.invalid',
              // React escapes; i18next must not (a “/” would read &#x2F;).
              { ...problem, interpolation: { escapeValue: false } },
            ),
          )
          .join(' ');
        return { fields: { allowedCidrs: { message } } };
      },
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await update.mutateAsync({
          allowedCidrs: cidrList(value.allowedCidrs),
        });
        toast.success(t('detail.allowlist.saved'));
      } catch (caught) {
        if (isApiError(caught) && caught.code === 'invalid_cidr') {
          form.setFieldMeta('allowedCidrs', (meta) => ({
            ...meta,
            isTouched: true,
            errorMap: {
              ...meta?.errorMap,
              onSubmit: { message: caught.detail },
            },
          }));
        } else if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Section
      title={t('detail.allowlist.title')}
      description={t('detail.allowlist.description')}
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
          <form.AppField name="allowedCidrs">
            {(field) => (
              <field.TextAreaField
                label={t('detail.allowlist.label')}
                rows={4}
                placeholder={t('detail.allowlist.placeholder')}
                description={
                  client.allowedCidrs.length === 0
                    ? t('detail.allowlist.none')
                    : undefined
                }
              />
            )}
          </form.AppField>
          <div>
            <form.AppForm>
              <form.SubmitButton>
                {t('detail.allowlist.save')}
              </form.SubmitButton>
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
  const remove = useDeleteClient(client.id);
  const navigate = useNavigate();
  return (
    <Section
      title={t('detail.state.title')}
      description={t('detail.state.activeDescription')}
    >
      <div className="flex flex-wrap gap-2">
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
                    onSuccess: () =>
                      toast.success(t('detail.state.reactivated')),
                  },
                )
              }
            >
              {t('detail.state.reactivate')}
            </Button>
          </div>
        )}
        {/* For good, unlike revoking: asked first, its name in the question. */}
        <ConfirmButton
          variant="destructive"
          title={t('detail.state.deleteTitle', { name: client.name })}
          description={t('detail.state.deleteDescription')}
          confirm={t('detail.state.deleteConfirm')}
          onConfirm={async () => {
            await remove.mutateAsync();
            toast.success(t('detail.state.deleted', { name: client.name }));
            await navigate({ to: '/api-clients' });
          }}
        >
          {t('detail.state.delete')}
        </ConfirmButton>
      </div>
    </Section>
  );
}
