import { createFileRoute } from '@tanstack/react-router';
import { requirePermission, unitsReaders } from '@/features/access/gate';
import { OrganizationPage } from '@/features/access/organization-page';

export const Route = createFileRoute('/_app/access/organization/')({
  beforeLoad: requirePermission(...unitsReaders),
  component: OrganizationPage,
});
