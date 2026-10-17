import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { RolesPage } from '@/features/access/roles-page';

export const Route = createFileRoute('/_app/access/roles/')({
  beforeLoad: requirePermission('Access.manageRoles'),
  component: RolesPage,
});
