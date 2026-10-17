import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { MailPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  invalidateAccess,
  invite,
  rolesQuery,
  teamsQuery,
  type InvitationBody,
} from '@/features/access/api';
import {
  endInPast,
  grantsBody,
  type GrantDraft,
} from '@/features/access/grants';
import { RoleGrantsPicker, TeamsPicker } from '@/features/access/pickers';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';

/**
 * Invite someone (`POST /v1/access/users`, 202): the address gets a link,
 * and the membership with these roles and teams comes when it is accepted.
 * With roles, the API wants a recent sign-in (the dialog asks for it).
 */
export function InviteDialog() {
  const { t } = useTranslation('access');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <MailPlusIcon />
        {t('invitations.invite')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('invitations.inviteTitle')}</DialogTitle>
            <DialogDescription>
              {t('invitations.inviteDescription')}
            </DialogDescription>
          </DialogHeader>
          {open && <InviteForm onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function InviteForm(props: { onDone: () => void }) {
  const { t } = useTranslation('access');
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery);
  const teams = useQuery(teamsQuery);
  const [error, setError] = useState<string>();
  const send = useMutation({
    mutationFn: (body: InvitationBody) => invite(body),
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const form = useAppForm({
    defaultValues: {
      email: '',
      name: '',
      grants: {} as GrantDraft,
      teamIds: [] as string[],
    },
    validators: {
      onSubmit: z.object({
        email: z.email(t('invitations.errors.email')),
        name: z.string().max(120),
        grants: z
          .record(z.string(), z.string())
          .refine(
            (grants) => !Object.values(grants).some((v) => endInPast(v)),
            t('grants.untilPast'),
          ),
        teamIds: z.array(z.string()),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const sent = await send.mutateAsync({
          email: value.email.trim(),
          ...(value.name.trim() && { name: value.name.trim() }),
          ...grantsBody(value.grants),
          ...(value.teamIds.length > 0 && { teamIds: value.teamIds }),
        });
        toast.success(t('invitations.sent', { email: sent.email }));
        props.onDone();
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  if (roles.isPending || teams.isPending) {
    return <Spinner />;
  }
  if (roles.isError || teams.isError) {
    return <FormAlert message={errorMessage(roles.error ?? teams.error)} />;
  }
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
        <form.AppField name="email">
          {(field) => (
            <field.TextField
              label={t('invitations.fields.email')}
              type="email"
              autoComplete="off"
              autoFocus
            />
          )}
        </form.AppField>
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label={t('invitations.fields.name')}
              description={t('invitations.fields.nameHint')}
            />
          )}
        </form.AppField>
        <form.Field name="grants">
          {(field) => (
            <RoleGrantsPicker
              idPrefix="invite"
              roles={roles.data}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <form.Field name="teamIds">
          {(field) => (
            <TeamsPicker
              idPrefix="invite"
              teams={teams.data}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <form.AppForm>
          <form.SubmitButton className="self-start">
            {t('invitations.send')}
          </form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}
