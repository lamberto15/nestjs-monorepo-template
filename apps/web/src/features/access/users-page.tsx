import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { DropdownMenuItem } from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import type { HeaderContext } from '@tanstack/react-table';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { ListPage } from '@/components/list-page';
import {
  invalidateAccess,
  invitationsQuery,
  resendInvitation,
  revokeInvitation,
  rolesQuery,
  type Invitation,
  type Member,
  type Role,
} from '@/features/access/api';
import { isEnded } from '@/features/access/grants';
import { InviteDialog } from '@/features/access/invite-dialog';
import { MemberSheet } from '@/features/access/member-sheet';
import { formatDateTime } from '@/lib/date-time';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/features';
import type { DataTableFeatures } from '@/lib/data-table-features';
import { FormAlert } from '@/lib/form';
import type { ListColumn } from '@/lib/list-query';

/**
 * The tenant's members (the generic list page, on GET /v1/lists/User) and,
 * for whoever manages users, its pending invitations. Whoever only manages
 * teams or impersonates reads the members (AccessPolicy.open): the
 * invitations and every change want manageUsers.
 */
export function UsersPage() {
  const { t } = useTranslation('access');
  const mayManage = useCan('Access.manageUsers');
  return (
    <div className="flex flex-col gap-8">
      <Members />
      {mayManage && (
        <section
          className="flex flex-col gap-2"
          aria-labelledby="invitations-title"
        >
          <h2 id="invitations-title" className="text-lg font-medium">
            {t('users.tabs.invitations')}
          </h2>
          <Invitations />
        </section>
      )}
    </div>
  );
}

function roleNames(roles: Map<string, Role>, ids: readonly string[]) {
  return ids.map((id) => roles.get(id)?.name ?? id);
}

function Members() {
  const { t } = useTranslation('access');
  const mayManage = useCan('Access.manageUsers');
  const roles = useQuery(rolesQuery);
  const roleById = useMemo(
    () => new Map((roles.data ?? []).map((role) => [role.id, role])),
    [roles.data],
  );
  const [selected, setSelected] = useState<string>();

  // Cells and headers only: which columns filter and sort, and how (the
  // team filter included), comes from GET /v1/lists/User (withListMeta).
  const columns = useMemo<ListColumn<Member>[]>(() => {
    const header = (key: string) => {
      const label = t(`users.columns.${key}`);
      return {
        meta: { label },
        header: ({
          column,
        }: HeaderContext<DataTableFeatures, Member, unknown>) => (
          <DataTableColumnHeader column={column} label={label} />
        ),
      };
    };
    return [
      {
        id: 'name',
        accessorFn: (m) => m.name || m.email,
        ...header('name'),
        // The keyboard's way into the member sheet.
        cell: ({ row }) => (
          <button
            type="button"
            className="font-medium underline-offset-4 hover:underline"
            onClick={() => setSelected(row.original.id)}
          >
            {row.original.name || row.original.email}
          </button>
        ),
      },
      { id: 'email', accessorKey: 'email', ...header('email') },
      {
        id: 'roles',
        accessorFn: (m) =>
          m.roles
            .filter((grant) => !isEnded(grant))
            .map((grant) => roleById.get(grant.roleId)?.name ?? grant.roleId)
            .join(', '),
        ...header('roles'),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.roles
              .filter((grant) => !isEnded(grant))
              .map((grant) => (
                <Badge key={grant.roleId} variant="outline">
                  {roleNames(roleById, [grant.roleId])[0]}
                  {grant.expiresAt &&
                    ` · ${t('grants.untilShort', { date: formatDateTime(grant.expiresAt) })}`}
                </Badge>
              ))}
          </div>
        ),
      },
      {
        id: 'active',
        accessorFn: (m) => m.active,
        ...header('status'),
        cell: ({ row }) => (
          <Badge variant={row.original.active ? 'secondary' : 'destructive'}>
            {t(
              row.original.active
                ? 'users.status.active'
                : 'users.status.inactive',
            )}
          </Badge>
        ),
      },
    ];
  }, [t, roleById]);

  // The sheet holds what one does to a member: roles, teams, remove or
  // restore access, impersonate (each by its own permission).
  const rowActions = useCallback(
    (member: Member) => (
      <DropdownMenuItem onClick={() => setSelected(member.id)}>
        {t('users.open')}
      </DropdownMenuItem>
    ),
    [t],
  );

  return (
    <>
      <ListPage
        subject="User"
        path="/v1/access/users"
        title={t('users.title')}
        columns={columns}
        rowActions={rowActions}
        toolbarActions={mayManage ? <InviteDialog /> : undefined}
      />
      <MemberSheet memberId={selected} onClose={() => setSelected(undefined)} />
    </>
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
