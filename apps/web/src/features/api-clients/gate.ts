import type { QueryClient } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';
import type { FeatureName } from '@/lib/features';
import { featuresQuery } from '@/lib/session';

/**
 * A route's `beforeLoad`: with the switch off there is no such page (the
 * API answers 404 `feature_off` for it too).
 */
export function requireFeature(name: FeatureName) {
  return async ({ context }: { context: { queryClient: QueryClient } }) => {
    const features = await context.queryClient.ensureQueryData(featuresQuery);
    if (features[name] !== true) {
      throw notFound();
    }
  };
}
