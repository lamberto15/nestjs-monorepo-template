import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Page, PageHeader } from '@/components/page-header';
import { requirePermission } from '@/features/access/gate';
import { RoleForm } from '@/features/access/role-form';

export const Route = createFileRoute('/_app/access/roles/new')({
  beforeLoad: requirePermission('Access.manageRoles'),
  component: NewRole,
});

function NewRole() {
  const { t } = useTranslation('access');
  return (
    <Page width="narrow">
      <PageHeader title={t('roles.newTitle')} />
      <RoleForm />
    </Page>
  );
}
