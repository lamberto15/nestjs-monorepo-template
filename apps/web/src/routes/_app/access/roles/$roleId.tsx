import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useTranslation } from 'react-i18next';
import { rolesQuery } from '@/features/access/api';
import { requirePermission } from '@/features/access/gate';
import { RoleForm } from '@/features/access/role-form';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';

export const Route = createFileRoute('/_app/access/roles/$roleId')({
  beforeLoad: requirePermission('Access.manageRoles'),
  component: EditRole,
});

// No GET of one role: the list has every role, with its permissions.
function EditRole() {
  const { t } = useTranslation('access');
  const { roleId } = Route.useParams();
  const roles = useQuery(rolesQuery);
  const role = roles.data?.find((item) => item.id === roleId);
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-medium">
        {role ? role.name : t('roles.editTitle')}
      </h1>
      {roles.isPending ? (
        <Spinner />
      ) : roles.isError ? (
        <FormAlert message={errorMessage(roles.error)} />
      ) : role ? (
        // A role changed elsewhere and refetched: a fresh form.
        <RoleForm key={role.updatedAt} role={role} />
      ) : (
        <FormAlert message={t('roles.notFound')} />
      )}
    </section>
  );
}
