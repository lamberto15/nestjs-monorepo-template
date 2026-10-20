import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
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
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { useQuery } from '@tanstack/react-query';
import { EyeIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Section } from '@/components/account/section';
import { ConfirmButton } from '@/components/confirm-button';
import { formatDateTime } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { useCan } from '@/lib/features';
import { z } from '@/lib/zod';
import {
  BREAK_GLASS_MAX_MINUTES,
  breakGlassQuery,
  grantActive,
  useEndBreakGlass,
  useStartBreakGlass,
  type BreakGlassGrant,
  type TenantRow,
} from './queries';

/**
 * Break-glass (docs/tenancy.md, "Break-glass"): the operator opens a tenant
 * it was never invited to, read only, for an hour at most, with a reason the
 * tenant's administrators are told. The section lists the operator's own
 * grants, opens one (a recent sign-in: lib/api.ts asks and retries) and ends
 * one early. Only for the holder of `Platform.breakGlass`, and never for the
 * operator tenant itself (409 `break_glass_own_tenant`).
 */
export function BreakGlassSection(props: { tenant: TenantRow }) {
  const allowed = useCan('Platform.breakGlass');
  if (!allowed || props.tenant.operator) {
    return null;
  }
  return <Grants tenant={props.tenant} />;
}

function Grants(props: { tenant: TenantRow }) {
  const { t } = useTranslation('tenants');
  const { tenant } = props;
  const [open, setOpen] = useState(false);
  const grants = useQuery(breakGlassQuery(tenant.id));
  const items = grants.data?.items ?? [];
  const active = items.find((grant) => grantActive(grant));
  return (
    <Section
      title={t('detail.breakGlass.title')}
      description={t('detail.breakGlass.description')}
    >
      {active && (
        <Alert role="status">
          <EyeIcon />
          <AlertTitle>
            {t('detail.breakGlass.activeTitle', {
              date: formatDateTime(active.expiresAt),
            })}
          </AlertTitle>
          <AlertDescription>
            {t('detail.breakGlass.activeHint')}
            <code className="mt-2 block break-all">
              Break-Glass: {active.id}
            </code>
          </AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={Boolean(active) || !tenant.active}
        onClick={() => setOpen(true)}
      >
        {t('detail.breakGlass.open')}
      </Button>
      {grants.isPending ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('detail.breakGlass.none')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {items.map((grant) => (
            <GrantRow key={grant.id} tenant={tenant} grant={grant} />
          ))}
        </ul>
      )}
      <OpenDialog tenant={tenant} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

function GrantRow(props: { tenant: TenantRow; grant: BreakGlassGrant }) {
  const { t } = useTranslation('tenants');
  const { grant, tenant } = props;
  const end = useEndBreakGlass(tenant.id);
  const live = grantActive(grant);
  const status = grant.endedAt ? 'ended' : live ? 'active' : 'expired';
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={live ? 'default' : 'outline'}>
            {t(`detail.breakGlass.status.${status}`)}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {t('detail.breakGlass.opened', {
              date: formatDateTime(grant.createdAt),
              until: formatDateTime(grant.endedAt ?? grant.expiresAt),
            })}
          </span>
        </div>
        <p className="text-sm break-words">{grant.reason}</p>
      </div>
      {live && (
        <ConfirmButton
          variant="destructive"
          disabled={end.isPending}
          title={t('detail.breakGlass.endTitle')}
          description={t('detail.breakGlass.endDescription')}
          confirm={t('detail.breakGlass.endConfirm')}
          onConfirm={async () => {
            try {
              await end.mutateAsync(grant.id);
              toast.success(t('detail.breakGlass.ended'));
            } catch (caught) {
              toast.error(errorMessage(caught));
              throw caught;
            }
          }}
        >
          {t('detail.breakGlass.end')}
        </ConfirmButton>
      )}
    </li>
  );
}

function OpenDialog(props: {
  tenant: TenantRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('tenants');
  const { tenant } = props;
  const [error, setError] = useState<string>();
  const start = useStartBreakGlass(tenant.id);
  const form = useAppForm({
    defaultValues: { reason: '', minutes: String(BREAK_GLASS_MAX_MINUTES) },
    validators: {
      onSubmit: z.object({
        reason: z
          .string()
          .trim()
          .min(10, t('detail.breakGlass.reasonInvalid'))
          .max(1000, t('detail.breakGlass.reasonInvalid')),
        minutes: z
          .string()
          .regex(/^\d+$/, t('detail.breakGlass.minutesInvalid'))
          .refine(
            (value) => {
              const n = Number(value);
              return n >= 1 && n <= BREAK_GLASS_MAX_MINUTES;
            },
            { message: t('detail.breakGlass.minutesInvalid') },
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await start.mutateAsync({
          reason: value.reason.trim(),
          minutes: Number(value.minutes),
        });
        form.reset();
        props.onOpenChange(false);
        toast.success(t('detail.breakGlass.started', { name: tenant.name }));
      } catch (caught) {
        if (isApiError(caught) && caught.code === 'reauthentication_required') {
          return;
        }
        if (!applyFieldErrors(form, caught)) {
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
            {t('detail.breakGlass.dialogTitle', { name: tenant.name })}
          </DialogTitle>
          <DialogDescription>
            {t('detail.breakGlass.dialogDescription')}
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
            <form.AppField name="reason">
              {(field) => (
                <field.TextAreaField
                  label={t('detail.breakGlass.reason')}
                  description={t('detail.breakGlass.reasonHint')}
                  rows={4}
                />
              )}
            </form.AppField>
            <form.AppField name="minutes">
              {(field) => (
                <field.TextField
                  label={t('detail.breakGlass.minutes', {
                    max: BREAK_GLASS_MAX_MINUTES,
                  })}
                  autoComplete="off"
                />
              )}
            </form.AppField>
            <DialogFooter>
              <form.AppForm>
                <form.SubmitButton>
                  {t('detail.breakGlass.submit')}
                </form.SubmitButton>
              </form.AppForm>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
