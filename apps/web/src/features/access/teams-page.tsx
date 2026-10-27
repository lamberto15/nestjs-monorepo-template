import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { Page, PageHeader } from '@/components/page-header';
import {
  deleteTeam,
  invalidateAccess,
  teamsQuery,
  type Team,
} from '@/features/access/api';
import { orderedTree } from '@/features/access/pickers';
import { TeamDialog } from '@/features/access/team-dialog';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';

/**
 * The team tree (docs/permissions.md, "Organization hierarchy"): what
 * "in my teams" covers. Deleting wants an empty team (409 otherwise).
 * Whoever manages users reads it too (to reach a team's members); changing
 * the tree wants manageTeams.
 */
export function TeamsPage() {
  const { t } = useTranslation('access');
  const teams = useQuery(teamsQuery);
  const mayChange = useCan('Access.manageTeams');
  const [editing, setEditing] = useState<Team | 'new'>();
  return (
    <Page>
      <PageHeader
        title={t('teams.title')}
        actions={
          mayChange && (
            <Button onClick={() => setEditing('new')}>
              <PlusIcon />
              {t('teams.new')}
            </Button>
          )
        }
      />
      {teams.isPending ? (
        <Spinner />
      ) : teams.isError ? (
        <FormAlert message={errorMessage(teams.error)} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('teams.columns.name')}</TableHead>
                <TableHead>{t('teams.columns.members')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    {t('teams.none')}
                  </TableCell>
                </TableRow>
              )}
              {orderedTree(teams.data).map((team) => (
                <TeamRow
                  key={team.id}
                  team={team}
                  mayChange={mayChange}
                  onEdit={() => setEditing(team)}
                />
              ))}
            </TableBody>
          </Table>
          <TeamDialog
            open={editing !== undefined}
            onOpenChange={(open) => !open && setEditing(undefined)}
            teams={teams.data}
            team={editing === 'new' ? undefined : editing}
          />
        </>
      )}
    </Page>
  );
}

function TeamRow(props: {
  team: Team;
  mayChange: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation('access');
  const { team } = props;
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteTeam(team.id),
    onSuccess: async () => {
      toast.success(t('teams.deleted', { name: team.name }));
      await invalidateAccess(queryClient);
    },
  });
  return (
    <TableRow>
      <TableCell>
        <span style={{ paddingInlineStart: `${team.depth * 1.25}rem` }}>
          <Link
            to="/access/teams/$teamId"
            params={{ teamId: team.id }}
            className="font-medium hover:underline"
          >
            {team.name}
          </Link>
        </span>
      </TableCell>
      <TableCell>{team.members}</TableCell>
      <TableCell>
        {props.mayChange && (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-10"
              onClick={props.onEdit}
            >
              <PencilIcon />
              {t('teams.edit')}
            </Button>
            <ConfirmButton
              size="sm"
              variant="outline"
              className="pointer-coarse:h-10"
              title={t('teams.deleteTitle', { name: team.name })}
              description={t('teams.deleteDescription')}
              confirm={t('teams.delete')}
              onConfirm={() => remove.mutateAsync()}
            >
              <Trash2Icon />
              {t('teams.delete')}
            </ConfirmButton>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
