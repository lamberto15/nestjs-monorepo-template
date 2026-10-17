import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { requirePermission } from '@/features/access/gate';
import { RoleForm } from '@/features/access/role-form';

export const Route = createFileRoute('/_app/access/roles/new')({
  beforeLoad: requirePermission('Access.manageRoles'),
  component: NewRole,
});

function NewRole() {
  const { t } = useTranslation('access');
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-medium">{t('roles.newTitle')}</h1>
      <RoleForm />
    </section>
  );
}
