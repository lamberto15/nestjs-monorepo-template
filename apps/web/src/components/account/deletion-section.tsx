import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  ApiError,
  isApiError,
  unwrap,
} from '@nestjs-monorepo-template/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  accountQuery,
  type AccountState,
} from '@/components/account/privacy-api';
import { api } from '@/lib/api';
import { useDateTimeFormat } from '@/lib/date-time';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { meQuery } from '@/lib/session';
import { z } from '@/lib/zod';

/** Whether what was typed is the account's address (case aside, as addresses are compared). */
export const confirmsEmail = (typed: string, email: string) =>
  typed.trim().toLowerCase() === email.trim().toLowerCase();

/** The API names the body's `password`; the form's field is `currentPassword`. */
function asFormError(error: unknown) {
  if (!isApiError(error) || !error.errors) {
    return error;
  }
  return new ApiError({
    ...error.problem,
    errors: error.errors.map((e) =>
      e.path === 'password' ? { ...e, path: 'currentPassword' } : e,
    ),
  });
}

/**
 * Deleting the account (docs/auth.md, "Your data, your account's deletion"):
 * `POST /v1/account/deletion { password? }` schedules it after the grace
 * period, wants a recent sign-in (the re-authenticate dialog, lib/api.ts)
 * and the password again when the account has one; a mail says when, with
 * a link that cancels it without signing in (/cancel-deletion). The
 * session goes on until the deletion is carried out; `DELETE` cancels it
 * from here.
 */
export function DeletionSection(props: { email: string }) {
  const { t } = useTranslation('privacy');
  const format = useDateTimeFormat();
  const queryClient = useQueryClient();
  const state = useQuery(accountQuery);
  const [open, setOpen] = useState(false);
  const keep = useMutation({
    mutationFn: async () => {
      await api.DELETE('/v1/account/deletion');
    },
    onSuccess: () => {
      queryClient.setQueryData<AccountState>(accountQuery.queryKey, (old) =>
        old ? { ...old, deletion: null } : old,
      );
      toast.success(t('deletion.kept'));
    },
    // A 404: nothing pending any more (cancelled by the link meanwhile).
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: accountQuery.queryKey }),
  });

  if (state.isPending) {
    return <Skeleton className="h-40 w-full" aria-busy />;
  }
  const deletion = state.data?.deletion;

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">
          {t('deletion.title')}
        </CardTitle>
        <CardDescription>{t('deletion.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {deletion ? (
          <>
            <Alert variant="destructive" role="status">
              <TriangleAlertIcon />
              <AlertTitle>
                {t('deletion.scheduled', {
                  date: format(deletion.scheduledFor),
                })}
              </AlertTitle>
              <AlertDescription>
                {t('deletion.scheduledHint', { email: props.email })}
              </AlertDescription>
            </Alert>
            <Button
              className="self-start"
              disabled={keep.isPending}
              onClick={() => keep.mutate()}
            >
              {keep.isPending && <Spinner />}
              {t('deletion.keep')}
            </Button>
          </>
        ) : (
          <>
            <ul className="list-disc ps-5 text-sm text-muted-foreground">
              <li>{t('deletion.grace')}</li>
              <li>{t('deletion.erased')}</li>
              <li>{t('deletion.keptRecords')}</li>
              <li>{t('deletion.audit')}</li>
              <li>{t('deletion.exportFirst')}</li>
            </ul>
            <Button
              variant="destructive"
              className="self-start"
              onClick={() => setOpen(true)}
            >
              {t('deletion.action')}
            </Button>
          </>
        )}
      </CardContent>
      <DeleteDialog open={open} onOpenChange={setOpen} email={props.email} />
    </Card>
  );
}

function DeleteDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
}) {
  const { t } = useTranslation('privacy');
  const format = useDateTimeFormat();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const request = useMutation({
    mutationFn: (body: { password?: string }) =>
      unwrap(api.POST('/v1/account/deletion', { body })),
    meta: { errorToast: false },
    // Its variables hold the password: dropped from the cache once reset.
    gcTime: 0,
  });
  const form = useAppForm({
    defaultValues: { confirmEmail: '', currentPassword: '' },
    validators: {
      onSubmit: z
        .object({ confirmEmail: z.string(), currentPassword: z.string() })
        .refine((value) => confirmsEmail(value.confirmEmail, props.email), {
          path: ['confirmEmail'],
          message: t('deletion.confirmMismatch'),
        }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const deletion = await request.mutateAsync(
          // An account without a password (links, providers): step-up alone.
          value.currentPassword ? { password: value.currentPassword } : {},
        );
        // The password must not outlive the request in the mutation cache.
        request.reset();
        form.reset();
        props.onOpenChange(false);
        queryClient.setQueryData<AccountState>(accountQuery.queryKey, (old) =>
          old ? { ...old, deletion } : { deletion, consents: [] },
        );
        toast.success(
          t('deletion.requested', {
            date: format(deletion.scheduledFor),
            email: props.email,
          }),
        );
        // The API keeps the session until the deletion is carried out. Ask
        // anyway: if it ended it, `me` comes back null and the app's watch
        // (lib/errors.ts) clears the session and goes to sign-in.
        await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      } catch (caught) {
        request.reset();
        // The re-authenticate dialog given up: nothing more to say.
        if (isApiError(caught) && caught.code === 'reauthentication_required') {
          return;
        }
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
          <DialogTitle>{t('deletion.confirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('deletion.confirmDescription')}
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
            <form.AppField name="confirmEmail">
              {(field) => (
                <field.TextField
                  label={t('deletion.confirmEmail', { email: props.email })}
                  type="email"
                  autoComplete="off"
                />
              )}
            </form.AppField>
            {/* Not `password`: the re-authenticate dialog, open over this
                one, has that field (and its id). */}
            <form.AppField name="currentPassword">
              {(field) => (
                <field.TextField
                  label={t('deletion.password')}
                  type="password"
                  autoComplete="current-password"
                  description={t('deletion.passwordHint')}
                />
              )}
            </form.AppField>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <MailIcon className="size-4 shrink-0" />
              {t('deletion.mailHint')}
            </p>
            <DialogFooter>
              <form.Subscribe
                selector={(s) =>
                  confirmsEmail(s.values.confirmEmail, props.email)
                }
              >
                {(confirmed) => (
                  <form.AppForm>
                    <form.SubmitButton disabled={!confirmed}>
                      {t('deletion.submit')}
                    </form.SubmitButton>
                  </form.AppForm>
                )}
              </form.Subscribe>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
