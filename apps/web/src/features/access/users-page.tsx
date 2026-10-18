import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nestjs-monorepo-template/ui/components/select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { SearchIcon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import {
  invalidateAccess,
  invitationsQuery,
  membersQuery,
  resendInvitation,
  revokeInvitation,
  rolesQuery,
  teamsQuery,
  type Invitation,
  type Role,
} from '@/features/access/api';
import { isEnded } from '@/features/access/grants';
import { InviteDialog } from '@/features/access/invite-dialog';
import { MemberSheet } from '@/features/access/member-sheet';
import { orderedTree } from '@/features/access/pickers';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import { FormAlert } from '@/lib/form';

/**
 * The tenant's members and, for whoever manages users, its pending
 * invitations. Whoever only manages teams or impersonates reads the members
 * (AccessPolicy.open): the invitations and every change want manageUsers.
 */
export function UsersPage() {
  const { t } = useTranslation('access');
  const mayManage = useCan('Access.manageUsers');
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-medium">{t('users.title')}</h1>
        {mayManage && (
          <div className="ms-auto">
            <InviteDialog />
          </div>
        )}
      </div>
      {mayManage ? (
        <Tabs defaultValue="members">
          <TabsList>
            <TabsTrigger value="members">{t('users.tabs.members')}</TabsTrigger>
            <TabsTrigger value="invitations">
              {t('users.tabs.invitations')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="members">
            <Members />
          </TabsContent>
          <TabsContent value="invitations">
            <Invitations />
          </TabsContent>
        </Tabs>
      ) : (
        <Members />
      )}
    </section>
  );
}

function roleNames(roles: Map<string, Role>, ids: readonly string[]) {
  return ids.map((id) => roles.get(id)?.name ?? id);
}

function Members() {
  const { t } = useTranslation('access');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [teamId, setTeamId] = useState<string | null>(null);
  const q = useDeferredValue(search.trim());
  const members = useQuery({
    ...membersQuery(page, q, teamId ?? ''),
    placeholderData: keepPreviousData,
  });
  const roles = useQuery(rolesQuery);
  const teams = useQuery(teamsQuery);
  const roleById = new Map((roles.data ?? []).map((role) => [role.id, role]));
  const [selected, setSelected] = useState<string>();
  // The row, shown while the sheet reads the member itself.
  const row = members.data?.items.find((m) => m.id === selected);
  const teamOptions = [
    { value: null, label: t('users.allTeams') },
    ...orderedTree(teams.data ?? []).map((team) => ({
      value: team.id as string | null,
      label: `${'\u2003'.repeat(team.depth)}${team.name}`,
    })),
  ];

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            className="ps-8"
            aria-label={t('users.search')}
            placeholder={t('users.search')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        {/* A team's direct members (`?teamId=`). */}
        <Select
          items={teamOptions}
          value={teamId}
          onValueChange={(value) => {
            setTeamId(value as string | null);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label={t('users.team')} className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {teamOptions.map((option) => (
              <SelectItem key={option.value ?? ''} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {members.isPending ? (
        <Spinner />
      ) : members.isError ? (
        <FormAlert message={errorMessage(members.error)} />
      ) : (
        <>
          <Table aria-busy={members.isPlaceholderData}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('users.columns.member')}</TableHead>
                <TableHead>{t('users.columns.roles')}</TableHead>
                <TableHead>{t('users.columns.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    {t('users.empty')}
                  </TableCell>
                </TableRow>
              )}
              {members.data.items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="flex flex-col items-start text-start hover:underline"
                      onClick={() => setSelected(m.id)}
                    >
                      <span className="font-medium">{m.name || m.email}</span>
                      <span className="text-xs text-muted-foreground">
                        {m.email}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {m.roles
                        .filter((grant) => !isEnded(grant))
                        .map((grant) => (
                          <Badge key={grant.roleId} variant="outline">
                            {roleNames(roleById, [grant.roleId])[0]}
                            {grant.expiresAt &&
                              ` · ${t('grants.untilShort', { date: formatDateTime(grant.expiresAt) })}`}
                          </Badge>
                        ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.active ? 'secondary' : 'destructive'}>
                      {t(
                        m.active
                          ? 'users.status.active'
                          : 'users.status.inactive',
                      )}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              {t('users.pageOf', {
                page,
                pages: members.data.pageCount ?? 1,
                total: members.data.total ?? members.data.items.length,
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ms-auto"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              {t('previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!members.data.nextPage}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('next')}
            </Button>
          </div>
        </>
      )}
      <MemberSheet
        memberId={selected}
        row={row}
        onClose={() => setSelected(undefined)}
      />
    </div>
  );
}

function Invitations() {
  const { t } = useTranslation('access');
  const invitations = useQuery(invitationsQuery);
  const roles = useQuery(rolesQuery);
  const roleById = new Map((roles.data ?? []).map((role) => [role.id, role]));
  if (invitations.isPending) return <Spinner />;
  if (invitations.isError) {
    return <FormAlert message={errorMessage(invitations.error)} />;
  }
  return (
    <Table className="mt-2">
      <TableHeader>
        <TableRow>
          <TableHead>{t('invitations.columns.email')}</TableHead>
          <TableHead>{t('invitations.columns.roles')}</TableHead>
          <TableHead>{t('invitations.columns.expires')}</TableHead>
          <TableHead>
            <span className="sr-only">{t('actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.data.length === 0 && (
          <TableRow>
            <TableCell colSpan={4} className="text-muted-foreground">
              {t('invitations.empty')}
            </TableCell>
          </TableRow>
        )}
        {invitations.data.map((invitation) => (
          <InvitationRow
            key={invitation.id}
            invitation={invitation}
            roles={roleById}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function InvitationRow(props: {
  invitation: Invitation;
  roles: Map<string, Role>;
}) {
  const { t } = useTranslation('access');
  const { invitation } = props;
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => revokeInvitation(invitation.id),
    onSuccess: async () => {
      toast.success(t('invitations.revoked', { email: invitation.email }));
      await invalidateAccess(queryClient);
    },
  });
  // A new link and expiry; the roles, their ends and the teams stay.
  const resend = useMutation({
    mutationFn: () => resendInvitation(invitation.id),
    onSuccess: async () => {
      toast.success(t('invitations.resent', { email: invitation.email }));
      await invalidateAccess(queryClient);
    },
  });
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">{invitation.email}</span>
          <span className="text-xs text-muted-foreground">
            {t('invitations.by', { who: invitation.invitedBy })}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {invitation.roleIds.map((roleId) => {
            // When the grant ends once accepted (none: never).
            const until = invitation.roleExpiresAt[roleId];
            return (
              <Badge key={roleId} variant="outline">
                {roleNames(props.roles, [roleId])[0]}
                {until &&
                  ` · ${t('grants.untilShort', { date: formatDateTime(until) })}`}
              </Badge>
            );
          })}
        </div>
      </TableCell>
      <TableCell>
        {invitation.expired ? (
          <Badge variant="destructive">{t('invitations.expired')}</Badge>
        ) : (
          formatDateTime(invitation.expiresAt)
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-2">
          <ConfirmButton
            size="sm"
            variant="ghost"
            title={t('invitations.resendTitle', { email: invitation.email })}
            description={t('invitations.resendDescription')}
            confirm={t('invitations.resend')}
            onConfirm={() => resend.mutateAsync()}
          >
            {t('invitations.resend')}
          </ConfirmButton>
          <ConfirmButton
            size="sm"
            variant="ghost"
            title={t('invitations.revokeTitle', { email: invitation.email })}
            description={t('invitations.revokeDescription')}
            confirm={t('invitations.revoke')}
            onConfirm={() => revoke.mutateAsync()}
          >
            {t('invitations.revoke')}
          </ConfirmButton>
        </div>
      </TableCell>
    </TableRow>
  );
}
