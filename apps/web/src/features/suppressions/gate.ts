import type { QueryClient } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';
import { meQuery } from '@/lib/session';

/**
 * The suppression list is the operators' (the API's `@OperatorOnly()`, 403
 * `operator_required` anywhere else) and takes `MailSuppression.view`. Decided
 * from `/me` (`tenant.operator`, `can`), so nobody else asks for the list
 * only to be refused: no such page for them. For the user's sake only.
 */
export async function requireMailOperator({
  context,
}: {
  context: { queryClient: QueryClient };
}) {
  const me = await context.queryClient.ensureQueryData(meQuery);
  if (
    me?.tenant?.operator !== true ||
    me.can['MailSuppression.view'] !== true
  ) {
    throw notFound();
  }
}
