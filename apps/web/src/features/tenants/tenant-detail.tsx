import { isApiError } from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { buttonVariants } from '@nestjs-monorepo-template/ui/components/button';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { ConflictAlert } from '@/components/records/conflict-alert';
import { formatDateTime } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { isNotFound, isPreconditionFailed } from '@/lib/records';
import { z } from '@/lib/zod';
import {
  slugPattern,
  tenantQuery,
  useUpdateTenant,
  type TenantRow,
} from './queries';

/**
 * One tenant, read on its own (`GET /v1/tenants/{id}`, with its ETag): rename
 * it, change its slug, deactivate and reactivate it. Every change sends the
 * ETag as `If-Match`, so a tenant another operator changed meanwhile is a
 * conflict to reload, not an overwrite. The operators only reach the page
 * (the route's gate).
 */
export function TenantDetail(props: { id: string }) {
  const { t } = useTranslation('tenants');
  // A 404 is this page's to say, not a toast's.
  const read = useQuery({
    ...tenantQuery(props.id),
    meta: { errorToast: false },
  });
  if (read.isPending) {
    return <Spinner />;
  }
  const loaded = read.data;
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Link
        to="/tenants"
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'self-start',
        )}
      >
        <ArrowLeftIcon className="rtl:rotate-180" />
        {t('detail.back')}
      </Link>
      {loaded ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-medium">{loaded.tenant.name}</h1>
            <Badge variant={loaded.tenant.active ? 'default' : 'outline'}>
              {t(`status.${loaded.tenant.active ? 'active' : 'inactive'}`)}
            </Badge>
            {loaded.tenant.operator && (
              <Badge variant="secondary">{t('list.operator')}</Badge>
            )}
            <span className="text-sm text-muted-foreground">
              {t('detail.created', {
                date: formatDateTime(loaded.tenant.createdAt),
              })}
            </span>
          </div>
          <NameSection
            // Read again after a change: a fresh form.
            key={`${loaded.tenant.updatedAt}-${loaded.etag}`}
            tenant={loaded.tenant}
            etag={loaded.etag}
          />
          <StateSection tenant={loaded.tenant} etag={loaded.etag} />
        </>
      ) : isNotFound(read.error) ? (
        <p className="text-sm text-muted-foreground">{t('detail.notFound')}</p>
      ) : (
        <FormAlert message={errorMessage(read.error)} />
      )}
    </div>
  );
}

/** The 412 of a change, and the way out: read the tenant again. */
function useConflict(id: string) {
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  return {
    conflict,
    reloading,
    clear: () => setConflict(false),
    /** True when the error was a 412, now shown as a conflict. */
    catches: (error: unknown) => {
      const stale = isPreconditionFailed(error);
      setConflict(stale);
      return stale;
    },
    reload: async () => {
      setReloading(true);
      try {
        await queryClient.invalidateQueries({
          queryKey: tenantQuery(id).queryKey,
        });
        setConflict(false);
      } finally {
        setReloading(false);
      }
    },
  };
}

function ConflictNotice(props: { conflict: ReturnType<typeof useConflict> }) {
  const { t } = useTranslation('tenants');
  return props.conflict.conflict ? (
    <ConflictAlert
      title={t('detail.conflict.title')}
      description={t('detail.conflict.description')}
      reload={t('detail.conflict.reload')}
      reloading={props.conflict.reloading}
      onReload={() => void props.conflict.reload()}
    />
  ) : null;
}

/** The name and the slug, saved together: only what changed is sent. */
function NameSection(props: { tenant: TenantRow; etag: string | undefined }) {
  const { t } = useTranslation('tenants');
  const { tenant } = props;
  const update = useUpdateTenant(tenant.id);
  const conflict = useConflict(tenant.id);
  const [error, setError] = useState<string>();
  const form = useAppForm({
    defaultValues: { name: tenant.name, slug: tenant.slug },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, t('create.nameRequired')).max(120),
        slug: z
          .string()
          .max(48, t('create.slugInvalid'))
          .regex(slugPattern, t('create.slugInvalid')),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const name = value.name.trim();
      const body = {
        ...(name !== tenant.name && { name }),
        ...(value.slug !== tenant.slug && { slug: value.slug }),
      };
      if (!Object.keys(body).length) {
        return;
      }
      try {
        await update.mutateAsync({ body, etag: props.etag });
        conflict.clear();
        toast.success(t('detail.saved', { name }));
      } catch (caught) {
        if (conflict.catches(caught)) {
          return;
        }
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Section
      title={t('detail.name.title')}
      description={t('detail.name.description')}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <ConflictNotice conflict={conflict} />
          <FormAlert message={error} />
          <form.AppField name="name">
            {(field) => <field.TextField label={t('create.name')} />}
          </form.AppField>
          <form.AppField name="slug">
            {(field) => (
              <field.TextField
                label={t('create.slug')}
                description={t('detail.name.slugHint')}
              />
            )}
          </form.AppField>
          <div>
            <form.AppForm>
              <form.SubmitButton>{t('detail.name.save')}</form.SubmitButton>
            </form.AppForm>
          </div>
        </FieldGroup>
      </form>
    </Section>
  );
}

/**
 * Deactivating ends the tenant's sessions and stops its API keys; nothing is
 * deleted, and reactivating gives it all back. Both are asked about first.
 * The operator tenant is never deactivated (the API answers 409
 * `operator_tenant`): no button offered for it.
 */
function StateSection(props: { tenant: TenantRow; etag: string | undefined }) {
  const { t } = useTranslation('tenants');
  const { tenant } = props;
  const update = useUpdateTenant(tenant.id);
  const conflict = useConflict(tenant.id);
  const change = async (active: boolean) => {
    try {
      await update.mutateAsync({ body: { active }, etag: props.etag });
      conflict.clear();
      toast.success(
        t(active ? 'detail.state.reactivated' : 'detail.state.deactivated', {
          name: tenant.name,
        }),
      );
    } catch (caught) {
      // A conflict is told in the page; anything else is a toast (the
      // confirmation stays open to try again).
      if (!conflict.catches(caught)) {
        toast.error(
          isApiError(caught) ? errorMessage(caught) : t('detail.state.failed'),
        );
      }
      throw caught;
    }
  };
  return (
    <Section
      title={t('detail.state.title')}
      description={t(
        tenant.active
          ? 'detail.state.activeDescription'
          : 'detail.state.inactiveDescription',
      )}
    >
      <ConflictNotice conflict={conflict} />
      {tenant.operator ? (
        <p className="text-sm text-muted-foreground">
          {t('detail.state.operatorTenant')}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tenant.active ? (
            <ConfirmButton
              variant="destructive"
              title={t('detail.state.deactivateTitle', { name: tenant.name })}
              description={t('detail.state.deactivateDescription')}
              confirm={t('detail.state.deactivateConfirm')}
              onConfirm={() => change(false)}
            >
              {t('detail.state.deactivate')}
            </ConfirmButton>
          ) : (
            <ConfirmButton
              title={t('detail.state.reactivateTitle', { name: tenant.name })}
              description={t('detail.state.reactivateDescription')}
              confirm={t('detail.state.reactivateConfirm')}
              onConfirm={() => change(true)}
            >
              {t('detail.state.reactivate')}
            </ConfirmButton>
          )}
        </div>
      )}
    </Section>
  );
}
