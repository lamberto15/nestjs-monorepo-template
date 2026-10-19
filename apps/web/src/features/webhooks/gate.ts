import type { QueryClient } from '@tanstack/react-query';
import { notFound, redirect } from '@tanstack/react-router';
import { featuresQuery, type Me } from '@/lib/session';

/**
 * A route's `beforeLoad`: the pages need WEBHOOKS and API_CLIENTS on (the
 * API answers 404 `feature_off` otherwise: webhooks are managed per API
 * client) and `Access.manageClients` (anyone else goes to the dashboard).
 * For the user's sake only: the API refuses them either way.
 */
export function requireWebhooks() {
  return async ({
    context,
  }: {
    context: { queryClient: QueryClient; me: Me };
  }) => {
    const features = await context.queryClient.ensureQueryData(featuresQuery);
    if (features.webhooks !== true || features.apiClients !== true) {
      throw notFound();
    }
    if (context.me.can['Access.manageClients'] !== true) {
      throw redirect({ to: '/' });
    }
  };
}
