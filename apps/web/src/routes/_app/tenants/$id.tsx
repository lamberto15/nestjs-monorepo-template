import { createFileRoute } from '@tanstack/react-router';
import { requireOperator } from '@/features/tenants/gate';
import { TenantDetail } from '@/features/tenants/tenant-detail';

export const Route = createFileRoute('/_app/tenants/$id')({
  beforeLoad: requireOperator,
  component: function Detail() {
    const { id } = Route.useParams();
    return <TenantDetail id={id} />;
  },
});
