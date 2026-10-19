import { createFileRoute } from '@tanstack/react-router';
import { requireOperator } from '@/features/tenants/gate';
import { TenantsPage } from '@/features/tenants/tenants-page';

export const Route = createFileRoute('/_app/tenants/')({
  beforeLoad: requireOperator,
  component: TenantsPage,
});
