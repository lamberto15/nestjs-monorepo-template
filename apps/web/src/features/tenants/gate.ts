import type { QueryClient } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';
import { featuresQuery, meQuery } from '@/lib/session';
import { isOperator } from './queries';

/**
 * The tenants page is the operators' and exists in multi-tenant
 * deployments only: no such page otherwise (the API refuses the same, 403
 * `operator_required`, 409 `single_tenant`). Decided from `/me`, so a tenant
 * administrator never asks the list only to be refused.
 */
export async function requireOperator({
  context,
}: {
  context: { queryClient: QueryClient };
}) {
  const { queryClient } = context;
  const features = await queryClient.ensureQueryData(featuresQuery);
  const me = await queryClient.ensureQueryData(meQuery);
  if (!isOperator(me, features.tenancy)) {
    throw notFound();
  }
}
