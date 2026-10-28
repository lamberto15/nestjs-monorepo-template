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
import { MailPlusIcon, UserPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  INVITATION_LIMITS,
  invalidateAccess,
  invite,
  rolesQuery,
  unitsQuery,
  updateInvitation,
  type Invitation,
  type InvitationChanges,
} from '@/features/access/api';
import {
  draftOf,
  endInPast,
  grantsBody,
  type GrantDraft,
} from '@/features/access/grants';
import { RoleGrantsPicker, UnitsPicker } from '@/features/access/pickers';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';

/**
 * `invite`: the address gets its link now. `prepare`: the member waits,
 * maybe without an address, until someone sends it from the invitations
 * list. `edit`: a pending invitation's address, name, roles and units.
 */
type Mode = 'invite' | 'prepare' | 'edit';

/**
 * The two ways an administrator adds someone (docs/identity.md, "Getting
 * people in"), both `POST /v1/access/users` (202): Invite member mails the
 * link now; Prepare member saves the roles and units without one. The
 * membership comes when the link is accepted. With roles, the API wants a
 * recent sign-in (the client asks for it).
 */
export function AddMemberButtons() {
  const { t } = useTranslation('access');
  const [mode, setMode] = useState<'invite' | 'prepare'>();
  return (
    <>
      <Button onClick={() => setMode('invite')}>
        <MailPlusIcon />
        {t('invitations.invite')}
      </Button>
      <Button variant="outline" onClick={() => setMode('prepare')}>
        <UserPlusIcon />
        {t('invitations.prepare')}
      </Button>
      <InvitationDialog
        mode={mode ?? 'invite'}
        open={mode !== undefined}
        onClose={() => setMode(undefined)}
      />
    </>
  );
}

/** The form of one mode in a dialog; `invitation` is the one `edit` changes. */
export function InvitationDialog(props: {
  mode: Mode;
  invitation?: Invitation;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('access');
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`invitations.${props.mode}Title`)}</DialogTitle>
          <DialogDescription>
            {t(`invitations.${props.mode}Description`)}
          </DialogDescription>
        </DialogHeader>
        {props.open && (
          <InvitationForm
            mode={props.mode}
            invitation={props.invitation}
            onDone={props.onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvitationForm(props: {
  mode: Mode;
  invitation?: Invitation;
  onDone: () => void;
}) {
  const { t } = useTranslation('access');
  const { mode, invitation } = props;
  const queryClient = useQueryClient();
  const roles = useQuery(rolesQuery);
  const units = useQuery(unitsQuery);
  const [error, setError] = useState<string>();
  const initial = {
    email: invitation?.email ?? '',
    name: invitation?.name ?? '',
    grants: invitation
      ? draftOf(
          invitation.roleIds.map((roleId) => ({
            roleId,
            expiresAt: invitation.roleExpiresAt[roleId] ?? null,
          })),
        )
      : ({} as GrantDraft),
    unitIds: invitation?.unitIds ?? ([] as string[]),
  };
  const save = useMutation({
    mutationFn: async (value: typeof initial) => {
      const email = value.email.trim();
      const name = value.name.trim();
      if (mode !== 'edit') {
        return invite({
          ...(email && { email }),
          ...(name && { name }),
          ...grantsBody(value.grants),
          ...(value.unitIds.length > 0 && { unitIds: value.unitIds }),
          send: mode === 'invite',
        });
      }
      // Only what changed: roles or a new address ask for a recent sign-in.
      const changes: InvitationChanges = {};
      if (email !== initial.email) changes.email = email || null;
      if (name !== initial.name) changes.name = name || null;
      if (JSON.stringify(value.grants) !== JSON.stringify(initial.grants)) {
        Object.assign(changes, grantsBody(value.grants));
      }
      if (value.unitIds.join() !== initial.unitIds.join()) {
        changes.unitIds = value.unitIds;
      }
      return updateInvitation(invitation!.id, changes);
    },
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const form = useAppForm({
    defaultValues: initial,
    validators: {
      onSubmit: z.object({
        // Inviting sends now: it needs the address. Preparing may wait.
        email:
          mode === 'invite'
            ? z.email(t('invitations.errors.email'))
            : z.union([z.literal(''), z.email(t('invitations.errors.email'))]),
        name: z.string().max(
          INVITATION_LIMITS.name,
          t('invitations.errors.nameTooLong', {
            max: INVITATION_LIMITS.name,
          }),
        ),
        grants: z
          .record(z.string(), z.string())
          .refine(
            (grants) => !Object.values(grants).some((v) => endInPast(v)),
            t('grants.untilPast'),
          ),
        unitIds: z.array(z.string()),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        const saved = await save.mutateAsync(value);
        const who = saved.email ?? t('invitations.noAddress');
        if (mode === 'invite') {
          toast.success(t('invitations.sent', { email: who }));
        } else if (
          mode === 'edit' &&
          invitation!.status !== 'prepared' &&
          saved.status === 'prepared'
        ) {
          // A new address: the link that went to the old one stopped.
          toast.success(t('invitations.linkWithdrawn', { email: who }));
        } else {
          toast.success(t('invitations.saved', { email: who }));
        }
        props.onDone();
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  if (roles.isPending || units.isPending) {
    return <Spinner />;
  }
  if (roles.isError || units.isError) {
    return <FormAlert message={errorMessage(roles.error ?? units.error)} />;
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
              label={t(
                mode === 'invite'
                  ? 'invitations.fields.email'
                  : 'invitations.fields.emailOptional',
              )}
              description={
                mode === 'invite'
                  ? undefined
                  : t('invitations.fields.emailHint')
              }
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
              idPrefix={mode}
              roles={roles.data}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <form.Field name="unitIds">
          {(field) => (
            <UnitsPicker
              idPrefix={mode}
              units={units.data}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
        <form.AppForm>
          <form.SubmitButton className="self-start">
            {t(mode === 'invite' ? 'invitations.send' : 'invitations.save')}
          </form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}
