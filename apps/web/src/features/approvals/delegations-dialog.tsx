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
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PersonPicker } from '@/components/person-picker';
import { useDateTimeFormat } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { useMe } from '@/lib/features';
import { FormAlert, useAppForm, useDescribedBy } from '@/lib/form';
import { personUserId } from '@/lib/people';
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
  const create = useCreateDelegation();
  const [error, setError] = useState<string>();
  // Remounts the picker after a delegation: it keeps its own search text.
  const [picker, setPicker] = useState(0);
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
          toUserId: personUserId(value.toUserId),
          startsAt: new Date(value.startsAt).toISOString(),
          endsAt: new Date(value.endsAt).toISOString(),
        });
        toast.success(t('delegations.created'));
        form.reset();
        setPicker((n) => n + 1);
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
        {/* People are searched (GET /v1/people, any member may): active
            users, not yourself. The field holds the key, `user:<id>` (named
            as the API's field, so its errors land on it); the id is sent. */}
        <form.Field name="toUserId">
          {(field) => (
            <PersonField
              key={picker}
              value={field.state.value}
              exclude={me ? [`user:${me.user.id}`] : []}
              invalid={field.state.meta.isTouched && !field.state.meta.isValid}
              errors={field.state.meta.errors}
              onChange={(value) => field.handleChange(value)}
            />
          )}
        </form.Field>
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
              <EndsAtField
                value={field.state.value}
                invalid={!field.state.meta.isValid}
                errors={field.state.meta.errors}
                onChange={(value) => field.handleChange(value)}
              />
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

type FieldErrors = ComponentProps<typeof FieldError>['errors'];

/** The person's picker; its error describes it (as lib/form.tsx's fields). */
function PersonField(props: {
  value: string;
  exclude: string[];
  invalid: boolean;
  errors: FieldErrors;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('approvals');
  const { controlId, errorId, describedBy } = useDescribedBy(
    false,
    props.invalid,
  );
  return (
    <Field data-invalid={props.invalid}>
      <FieldLabel htmlFor={controlId}>{t('delegations.person')}</FieldLabel>
      <PersonPicker
        id={controlId}
        label={t('delegations.person')}
        placeholder={t('delegations.choose')}
        exclude={props.exclude}
        value={props.value}
        onChange={props.onChange}
        invalid={props.invalid}
        describedBy={describedBy}
      />
      {props.invalid && <FieldError id={errorId} errors={props.errors} />}
    </Field>
  );
}

/** The end of the period; its error describes it. */
function EndsAtField(props: {
  value: string;
  invalid: boolean;
  errors: FieldErrors;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('approvals');
  const { controlId, errorId, describedBy } = useDescribedBy(
    false,
    props.invalid,
  );
  return (
    <Field data-invalid={props.invalid}>
      <FieldLabel htmlFor={controlId}>{t('delegations.to')}</FieldLabel>
      <Input
        id={controlId}
        type="datetime-local"
        value={props.value}
        aria-invalid={props.invalid}
        aria-describedby={describedBy}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.invalid && <FieldError id={errorId} errors={props.errors} />}
    </Field>
  );
}
