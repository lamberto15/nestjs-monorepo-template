import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { allMembersQuery } from '@/features/access/api';
import { useDateTimeFormat } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';
import { delegationsQuery, useCreateDelegation, useEndDelegation } from './api';

/** `<input type="datetime-local">` value of a moment (local time). */
function localValue(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/**
 * Out of office (docs/approvals.md, "Delegation"): who decides your approvals
 * for a while, and the delegations you give and hold. There is no
 * per-request hand-over in the API; delegating is a period.
 */
export function DelegationsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('approvals');
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('delegations.title')}</DialogTitle>
          <DialogDescription>{t('delegations.description')}</DialogDescription>
        </DialogHeader>
        {props.open && <DelegationsBody />}
      </DialogContent>
    </Dialog>
  );
}

function DelegationsBody() {
  const { t } = useTranslation('approvals');
  const date = useDateTimeFormat();
  const me = useMe();
  const list = useQuery(delegationsQuery);
  const end = useEndDelegation();
  const items = list.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      <DelegationForm />
      <section aria-label={t('delegations.list')}>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('delegations.none')}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {items.map((item) => {
              const given = item.fromUserId === me?.user.id;
              return (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2 p-3 text-sm"
                >
                  <div>
                    <p className="font-medium">
                      {given
                        ? t('delegations.given', { name: item.toName })
                        : t('delegations.held', { name: item.fromName })}
                    </p>
                    <p className="text-muted-foreground">
                      {t('delegations.period', {
                        from: date(item.startsAt),
                        to: date(item.endsAt),
                      })}
                    </p>
                  </div>
                  {given && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={end.isPending}
                      onClick={() => end.mutate(item.id)}
                    >
                      {t('delegations.end')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function DelegationForm() {
  const { t } = useTranslation('approvals');
  const me = useMe();
  const members = useQuery({ ...allMembersQuery, meta: { errorToast: false } });
  const create = useCreateDelegation();
  const [error, setError] = useState<string>();
  const people = (members.data ?? []).filter(
    (member) => member.active && member.id !== me?.user.id,
  );
  // The default period, fixed when the form opens: now, for a week.
  const [period] = useState(() => {
    const now = new Date();
    return {
      startsAt: localValue(now),
      endsAt: localValue(new Date(now.getTime() + 7 * 86_400_000)),
    };
  });
  const form = useAppForm({
    defaultValues: { toUserId: '', ...period },
    validators: {
      onSubmit: z
        .object({
          toUserId: z.string().min(1, t('delegations.errors.person')),
          startsAt: z.string().min(1, t('delegations.errors.dates')),
          endsAt: z.string().min(1, t('delegations.errors.dates')),
        })
        .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
          path: ['endsAt'],
          message: t('delegations.errors.order'),
        }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await create.mutateAsync({
          toUserId: value.toUserId,
          startsAt: new Date(value.startsAt).toISOString(),
          endsAt: new Date(value.endsAt).toISOString(),
        });
        toast.success(t('delegations.created'));
        form.reset();
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <FormAlert message={error} />
        {members.isError && (
          <FormAlert message={t('delegations.errors.people')} />
        )}
        <form.AppField name="toUserId">
          {(field) => (
            <field.SelectField
              label={t('delegations.person')}
              placeholder={t('delegations.choose')}
              options={people.map((member) => ({
                value: member.id,
                label: member.name ?? member.email,
              }))}
            />
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.Field name="startsAt">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="delegation-from">
                  {t('delegations.from')}
                </FieldLabel>
                <Input
                  id="delegation-from"
                  type="datetime-local"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="endsAt">
            {(field) => (
              <Field data-invalid={!field.state.meta.isValid}>
                <FieldLabel htmlFor="delegation-to">
                  {t('delegations.to')}
                </FieldLabel>
                <Input
                  id="delegation-to"
                  type="datetime-local"
                  value={field.state.value}
                  aria-invalid={!field.state.meta.isValid}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                {!field.state.meta.isValid && (
                  <FieldError errors={field.state.meta.errors} />
                )}
              </Field>
            )}
          </form.Field>
        </div>
        <FieldDescription>{t('delegations.hint')}</FieldDescription>
        <form.AppForm>
          <form.SubmitButton className="self-start">
            {t('delegations.create')}
          </form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}
