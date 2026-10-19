import type { QueryClient } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';
import { isApiError } from '@nestjs-monorepo-template/api-client';
import { featuresQuery, meQuery } from '@/lib/session';
import { tenantsAdminQuery } from './queries';

/**
 * The tenants page is the operators' and exists in multi-tenant
 * deployments only: no such page otherwise (the API refuses the same, 403
 * `operator_required`, 409 `single_tenant`).
 */
export async function requireOperator({
  context,
}: {
  context: { queryClient: QueryClient };
}) {
  const { queryClient } = context;
  const features = await queryClient.ensureQueryData(featuresQuery);
  const me = await queryClient.ensureQueryData(meQuery);
  if (
    features.tenancy !== 'multi' ||
    me?.can['Access.manageTenants'] !== true
  ) {
    throw notFound();
  }
  try {
    await queryClient.ensureQueryData(tenantsAdminQuery);
  } catch (error) {
    if (isApiError(error) && error.status === 403) {
      throw notFound();
    }
    throw error;
  }
}
