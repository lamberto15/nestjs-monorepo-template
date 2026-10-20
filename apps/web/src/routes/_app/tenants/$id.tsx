import { createFileRoute, notFound } from '@tanstack/react-router';
import { z } from '@/lib/zod';
import { requireOperator } from '@/features/tenants/gate';
import { TenantDetail } from '@/features/tenants/tenant-detail';

export const Route = createFileRoute('/_app/tenants/$id')({
  // An id that is no UUID names no tenant: not found, not a 400 from the API.
  beforeLoad: async (options) => {
    await requireOperator(options);
    if (!z.uuid().safeParse(options.params.id).success) {
      throw notFound();
    }
  },
  component: function Detail() {
    const { id } = Route.useParams();
    return <TenantDetail id={id} />;
  },
});
