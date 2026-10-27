import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import { FieldGroup } from '@nestjs-monorepo-template/ui/components/field';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  createTeam,
  invalidateAccess,
  type Team,
  TEAM_LIMITS,
  updateTeam,
} from '@/features/access/api';
import { orderedTree } from '@/features/access/pickers';
import { applyFieldErrors, errorMessage } from '@/lib/errors';
import { FormAlert, useAppForm } from '@/lib/form';
import { z } from '@/lib/zod';

const TOP = '-';

/** The teams a team may move under: not itself, nor any team below it. */
export function parentChoices(teams: readonly Team[], team?: Team): Team[] {
  if (!team) return orderedTree(teams);
  const below = new Set<string>([team.id]);
  // Tree order puts every team after its parent: one pass collects them.
  for (const candidate of orderedTree(teams)) {
    if (candidate.parentId && below.has(candidate.parentId)) {
      below.add(candidate.id);
    }
  }
  return orderedTree(teams).filter((t) => !below.has(t.id));
}

/** Create a team, or rename / move one (`/v1/access/teams`, Access.manageTeams). */
export function TeamDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: Team[];
  team?: Team;
}) {
  const { t } = useTranslation('access');
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(props.team ? 'teams.editTitle' : 'teams.newTitle')}
          </DialogTitle>
          <DialogDescription>{t('teams.dialogDescription')}</DialogDescription>
        </DialogHeader>
        {props.open && (
          <TeamForm
            teams={props.teams}
            team={props.team}
            onDone={() => props.onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TeamForm(props: { teams: Team[]; team?: Team; onDone: () => void }) {
  const { t } = useTranslation('access');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (body: { name: string; parentId: string | null }) =>
      props.team ? updateTeam(props.team.id, body) : createTeam(body),
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const form = useAppForm({
    defaultValues: {
      name: props.team?.name ?? '',
      parentId: props.team?.parentId ?? TOP,
    },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t('teams.errors.nameRequired'))
          .max(
            TEAM_LIMITS.name,
            t('teams.errors.nameTooLong', { max: TEAM_LIMITS.name }),
          ),
        parentId: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        await save.mutateAsync({
          name: value.name.trim(),
          parentId: value.parentId === TOP ? null : value.parentId,
        });
        toast.success(t(props.team ? 'teams.saved' : 'teams.created'));
        props.onDone();
      } catch (caught) {
        if (!applyFieldErrors(form, caught)) {
          setError(errorMessage(caught));
        }
      }
    },
  });
  const options = [
    { value: TOP, label: t('teams.topLevel') },
    ...parentChoices(props.teams, props.team).map((team) => ({
      value: team.id,
      label: `${'— '.repeat(team.depth)}${team.name}`,
    })),
  ];
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
        <form.AppField name="name">
          {(field) => (
            <field.TextField label={t('teams.fields.name')} autoFocus />
          )}
        </form.AppField>
        <form.AppField name="parentId">
          {(field) => (
            <field.SelectField
              label={t('teams.fields.parent')}
              options={options}
            />
          )}
        </form.AppField>
        <form.AppForm>
          <form.SubmitButton className="self-start">
            {t(props.team ? 'teams.save' : 'teams.create')}
          </form.SubmitButton>
        </form.AppForm>
      </FieldGroup>
    </form>
  );
}
