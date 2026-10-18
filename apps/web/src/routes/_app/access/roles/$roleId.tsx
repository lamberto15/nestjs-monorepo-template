import { isApiError } from '@nestjs-monorepo-template/api-client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useTranslation } from 'react-i18next';
import { roleQuery } from '@/features/access/api';
import { requirePermission } from '@/features/access/gate';
import { RoleForm } from '@/features/access/role-form';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';

export const Route = createFileRoute('/_app/access/roles/$roleId')({
  beforeLoad: requirePermission('Access.manageRoles'),
  component: EditRole,
});

/** One role, read on its own (`GET /v1/access/roles/{id}`). */
function EditRole() {
  const { t } = useTranslation('access');
  const { roleId } = Route.useParams();
  // A 404 is this page's to say, not a toast's.
  const role = useQuery({ ...roleQuery(roleId), meta: { errorToast: false } });
  const missing = isApiError(role.error) && role.error.status === 404;
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-medium">
        {role.data ? role.data.name : t('roles.editTitle')}
      </h1>
      {role.isPending ? (
        <Spinner />
      ) : missing ? (
        <FormAlert message={t('roles.notFound')} />
      ) : role.isError ? (
        <FormAlert message={errorMessage(role.error)} />
      ) : (
        // A role changed elsewhere and refetched: a fresh form.
        <RoleForm key={role.data.updatedAt} role={role.data} />
      )}
    </section>
  );
}
