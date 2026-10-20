import type { QueryClient } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';
import { meQuery } from '@/lib/session';
import { canViewOps } from './queries';

/**
 * The operations page is the operators' (the operator tenant, `Ops.view`):
 * no such page for anyone else, and no request sent to be refused. Decided
 * from `/me`; the API refuses the same (403 `operator_required`).
 */
export async function requireOpsOperator({
  context,
}: {
  context: { queryClient: QueryClient };
}) {
  const me = await context.queryClient.ensureQueryData(meQuery);
  if (!canViewOps(me)) {
    throw notFound();
  }
}
