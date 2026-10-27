import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import {
  Button,
  buttonVariants,
} from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { PrincipalPicker } from '@/components/principal-picker';
import {
  invalidateAccess,
  memberQuery,
  teamMembersQuery,
  teamsQuery,
  updateMember,
  type Member,
} from '@/features/access/api';
import { errorMessage } from '@/lib/errors';
import { useCan, useMe } from '@/lib/features';
import { FormAlert } from '@/lib/form';

/**
 * A team's direct members (`GET /v1/access/users?teamId=`). Membership is
 * the member's (`teamIds` of `PATCH /v1/access/users/{id}`), so adding and
 * removing want Access.manageUsers, not manageTeams, and nobody changes
 * their own teams. Whom to add is searched (`GET /v1/access/principals`),
 * then read on their own for the teams they already have.
 */
export function TeamMembers(props: { teamId: string }) {
  const { t } = useTranslation('access');
  const teams = useQuery(teamsQuery);
  const members = useQuery(teamMembersQuery(props.teamId));
  const mayChange = useCan('Access.manageUsers');
  const me = useMe();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState('');
  // A new picker (an empty input) after each addition.
  const [picker, setPicker] = useState(0);
  const [error, setError] = useState<string>();
  const change = useMutation({
    mutationFn: (args: { member: Member; teamIds: string[] }) =>
      updateMember(args.member.id, { teamIds: args.teamIds }),
    meta: { errorToast: false },
    onSuccess: () => invalidateAccess(queryClient),
  });
  const run = async (member: Member, teamIds: string[], done: string) => {
    setError(undefined);
    try {
      await change.mutateAsync({ member, teamIds });
      toast.success(done);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    }
  };
  const add = async (teamId: string) => {
    setError(undefined);
    let member: Member;
    try {
      // Their teams as they are now: the PATCH replaces the whole list.
      member = await queryClient.fetchQuery({
        ...memberQuery(adding),
        staleTime: 0,
      });
    } catch (caught) {
      setError(errorMessage(caught));
      return;
    }
    if (member.teamIds.includes(teamId)) {
      setAdding('');
      setPicker((n) => n + 1);
      return;
    }
    await run(
      member,
      [...member.teamIds, teamId],
      t('teams.memberAdded', { email: member.email }),
    )
      .then(() => {
        setAdding('');
        setPicker((n) => n + 1);
      })
      .catch(() => {});
  };

  if (teams.isPending || members.isPending) return <Spinner />;
  if (teams.isError || members.isError) {
    return <FormAlert message={errorMessage(teams.error ?? members.error)} />;
  }
  const team = teams.data.find((item) => item.id === props.teamId);
  if (!team) {
    return <FormAlert message={t('teams.notFound')} />;
  }
  const inTeam = members.data;
  // Nobody adds themselves, nor someone already in.
  const exclude = [
    ...inTeam.map((m) => m.id),
    ...(me?.user.id ? [me.user.id] : []),
  ];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link
          to="/access/teams"
          aria-label={t('teams.back')}
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <ArrowLeftIcon className="rtl:rotate-180" />
        </Link>
        <h1 className="text-xl font-medium">{team.name}</h1>
      </div>
      <FormAlert message={error} />
      {!mayChange && (
        <Alert>
          <AlertDescription>{t('teams.needsManageUsers')}</AlertDescription>
        </Alert>
      )}
      {mayChange && (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="max-w-sm">
            <FieldLabel htmlFor="team-add">{t('teams.addMember')}</FieldLabel>
            <PrincipalPicker
              key={picker}
              id="team-add"
              label={t('teams.addMember')}
              placeholder={t('teams.pickMember')}
              kind="user"
              active
              by="id"
              exclude={exclude}
              value={adding}
              onChange={(value) => setAdding(value)}
            />
          </Field>
          <Button
            disabled={!adding || change.isPending}
            onClick={() => void add(team.id)}
          >
            {change.isPending && <Spinner />}
            {t('teams.add')}
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('teams.columns.member')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {inTeam.length === 0 && (
            <TableRow>
              <TableCell colSpan={2} className="text-muted-foreground">
                {t('teams.noMembers')}
              </TableCell>
            </TableRow>
          )}
          {inTeam.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-medium">
                    {member.name || member.email}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {member.email}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-end">
                {mayChange && member.id !== me?.user.id && (
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    title={t('teams.removeTitle', {
                      email: member.email,
                      team: team.name,
                    })}
                    description={t('teams.removeDescription')}
                    confirm={t('teams.remove')}
                    onConfirm={() =>
                      run(
                        member,
                        member.teamIds.filter((id) => id !== team.id),
                        t('teams.memberRemoved', { email: member.email }),
                      )
                    }
                  >
                    {t('teams.remove')}
                  </ConfirmButton>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
