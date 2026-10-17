import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
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
import { PlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/confirm-button';
import {
  deleteRole,
  invalidateAccess,
  rolesQuery,
  type Role,
} from '@/features/access/api';
import { FormAlert } from '@/lib/form';
import { errorMessage } from '@/lib/errors';

/** The tenant's roles: who has each, what it grants; built-in ones read-only. */
export function RolesPage() {
  const { t } = useTranslation('access');
  const roles = useQuery(rolesQuery);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-medium">{t('roles.title')}</h1>
        <Button
          className="ms-auto"
          nativeButton={false}
          render={<Link to="/access/roles/new" />}
        >
          <PlusIcon />
          {t('roles.new')}
        </Button>
      </div>
      {roles.isPending ? (
        <Spinner />
      ) : roles.isError ? (
        <FormAlert message={errorMessage(roles.error)} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('roles.columns.name')}</TableHead>
              <TableHead>{t('roles.columns.permissions')}</TableHead>
              <TableHead>{t('roles.columns.members')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.data.map((role) => (
              <RoleRow key={role.id} role={role} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function RoleRow({ role }: { role: Role }) {
  const { t } = useTranslation('access');
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteRole(role.id),
    onSuccess: async () => {
      toast.success(t('roles.deleted', { name: role.name }));
      await invalidateAccess(queryClient);
    },
  });
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="flex items-center gap-2 font-medium">
            <Link to="/access/roles/$roleId" params={{ roleId: role.id }}>
              {role.name}
            </Link>
            {role.system && (
              <Badge variant="secondary">{t('roles.builtInBadge')}</Badge>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {role.description}
          </span>
        </div>
      </TableCell>
      <TableCell>
        {role.system
          ? t('roles.everything')
          : t('roles.permissionCount', { count: role.permissions.length })}
      </TableCell>
      <TableCell>{role.members}</TableCell>
      <TableCell className="text-end">
        {!role.system && (
          <ConfirmButton
            size="sm"
            variant="ghost"
            title={t('roles.deleteTitle', { name: role.name })}
            description={t('roles.deleteDescription', {
              count: role.members,
            })}
            confirm={t('roles.delete')}
            onConfirm={() => remove.mutateAsync()}
          >
            {t('roles.delete')}
          </ConfirmButton>
        )}
      </TableCell>
    </TableRow>
  );
}
