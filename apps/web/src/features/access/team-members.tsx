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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
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
import {
  allMembersQuery,
  invalidateAccess,
  teamsQuery,
  updateMember,
  type Member,
} from '@/features/access/api';
import { errorMessage } from '@/lib/errors';
import { useCan, useMe } from '@/lib/features';
import { FormAlert } from '@/lib/form';

/**
 * A team's direct members. Membership is the member's (`teamIds` of
 * `PATCH /v1/access/users/{id}`), so adding and removing want
 * Access.manageUsers, not manageTeams, and nobody changes their own teams.
 * The users list has no team filter: every member is read, then filtered.
 */
export function TeamMembers(props: { teamId: string }) {
  const { t } = useTranslation('access');
  const teams = useQuery(teamsQuery);
  const members = useQuery(allMembersQuery);
  const mayChange = useCan('Access.manageUsers');
  const me = useMe();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);
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

  if (teams.isPending || members.isPending) return <Spinner />;
  if (teams.isError || members.isError) {
    return <FormAlert message={errorMessage(teams.error ?? members.error)} />;
  }
  const team = teams.data.find((item) => item.id === props.teamId);
  if (!team) {
    return <FormAlert message={t('teams.notFound')} />;
  }
  const inTeam = members.data.filter((m) => m.teamIds.includes(team.id));
  const others = members.data.filter(
    (m) => m.active && !m.teamIds.includes(team.id) && m.id !== me?.user.id,
  );
  const options = others.map((m) => ({
    value: m.id,
    label: m.name ? `${m.name} (${m.email})` : m.email,
  }));

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
            <Select
              items={options}
              value={adding}
              onValueChange={(value) => setAdding(value as string | null)}
            >
              <SelectTrigger id="team-add" className="w-full">
                <SelectValue placeholder={t('teams.pickMember')} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button
            disabled={!adding || change.isPending}
            onClick={() => {
              const member = others.find((m) => m.id === adding);
              if (!member) return;
              void run(
                member,
                [...member.teamIds, team.id],
                t('teams.memberAdded', { email: member.email }),
              )
                .then(() => setAdding(null))
                .catch(() => {});
            }}
          >
            {change.isPending && <Spinner />}
            {t('teams.add')}
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('users.columns.member')}</TableHead>
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
