import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { ApiError, isApiError } from '@nestjs-monorepo-template/api-client';
import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { formatDateTime } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import {
  deletionPending,
  useCancelTenantDeletion,
  useRequestTenantDeletion,
  type TenantRow,
} from './queries';

/** Whether what was typed is the tenant's slug (the API compares it as is). */
export const confirmsSlug = (typed: string, slug: string) =>
  typed.trim() === slug;

/** The API names the body's `slug`; the form's field is `confirmSlug`. */
function asFormError(error: unknown) {
  if (!isApiError(error) || !error.errors) {
    return error;
  }
  return new ApiError({
    ...error.problem,
    errors: error.errors.map((e) =>
      e.path === 'slug' ? { ...e, path: 'confirmSlug' } : e,
    ),
  });
}

/**
 * Deleting the tenant (docs/tenancy.md, "Deleting a tenant"): the operator
 * types its slug, the tenant is deactivated now and erased after the grace
 * period, and until the erase starts the deletion can be cancelled. The
 * request wants a recent sign-in (lib/api.ts asks and retries). The operator
 * tenant is never deleted (409 `operator_tenant`): the page hides this
 * section for it.
 */
export function DeletionSection(props: { tenant: TenantRow }) {
  const { t } = useTranslation('tenants');
  const { tenant } = props;
  const [open, setOpen] = useState(false);
  const cancel = useCancelTenantDeletion(tenant.id);
  const keep = async () => {
    try {
      await cancel.mutateAsync();
      toast.success(t('detail.deletion.cancelled', { name: tenant.name }));
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'reauthentication_required') {
        return;
      }
      toast.error(
        isApiError(caught) && caught.code === 'tenant_deletion_started'
          ? t('detail.deletion.startedHint')
          : errorMessage(caught),
      );
    }
  };
  return (
    <Section
      title={t('detail.deletion.title')}
      description={t('detail.deletion.description')}
    >
      {tenant.deletionStartedAt ? (
        <Alert variant="destructive" role="status">
          <TriangleAlertIcon />
          <AlertTitle>{t('detail.deletion.started')}</AlertTitle>
          <AlertDescription>
            {t('detail.deletion.startedHint')}
          </AlertDescription>
        </Alert>
      ) : deletionPending(tenant) ? (
        <>
          <Alert variant="destructive" role="status">
            <TriangleAlertIcon />
            <AlertTitle>
              {t('detail.deletion.scheduled', {
                date: formatDateTime(tenant.deletionScheduledFor),
              })}
            </AlertTitle>
            <AlertDescription>
              {t('detail.deletion.scheduledHint')}
            </AlertDescription>
          </Alert>
          <Button
            type="button"
            className="self-start"
            disabled={cancel.isPending}
            onClick={() => void keep()}
          >
            {cancel.isPending && <Spinner />}
            {t('detail.deletion.cancel')}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="destructive"
          className="self-start"
          onClick={() => setOpen(true)}
        >
          {t('detail.deletion.action')}
        </Button>
      )}
      <DeleteDialog tenant={tenant} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

function DeleteDialog(props: {
  tenant: TenantRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('tenants');
  const { tenant } = props;
  const [error, setError] = useState<string>();
  const request = useRequestTenantDeletion(tenant.id);
  const form = useAppForm({
    defaultValues: { confirmSlug: '' },
    validators: {
      onSubmit: z.object({
        confirmSlug: z
          .string()
          .refine((value) => confirmsSlug(value, tenant.slug), {
            message: t('detail.deletion.mismatch'),
          }),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const deleted = await request.mutateAsync(value.confirmSlug.trim());
        form.reset();
        props.onOpenChange(false);
        toast.success(
          t('detail.deletion.requested', {
            name: tenant.name,
            date: formatDateTime(deleted.deletionScheduledFor),
          }),
        );
      } catch (caught) {
        // The re-authenticate dialog given up: nothing more to say.
        if (isApiError(caught) && caught.code === 'reauthentication_required') {
          return;
        }
        // The API names its body's `slug`; the form's field is `confirmSlug`.
        if (!applyFieldErrors(form, asFormError(caught))) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        props.onOpenChange(next);
        if (!next) {
          form.reset();
          setError(undefined);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('detail.deletion.confirmTitle', { name: tenant.name })}
          </DialogTitle>
          <DialogDescription>
            {t('detail.deletion.confirmDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <FormAlert message={error} />
            {/* Not `slug`: the name section's field has that name (and id). */}
            <form.AppField name="confirmSlug">
              {(field) => (
                <field.TextField
                  label={t('detail.deletion.confirmSlug', {
                    slug: tenant.slug,
                  })}
                  autoComplete="off"
                />
              )}
            </form.AppField>
            <DialogFooter>
              <form.Subscribe
                selector={(s) =>
                  [
                    confirmsSlug(s.values.confirmSlug, tenant.slug),
                    s.isSubmitting,
                  ] as const
                }
              >
                {([confirmed, submitting]) => (
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={!confirmed || submitting}
                  >
                    {submitting && <Spinner />}
                    {t('detail.deletion.submit')}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
