import { createFileRoute } from '@tanstack/react-router';
import { requireFeature } from '@/features/api-clients/gate';
import {
  UsagePage,
  usageRanges,
  type UsageRange,
} from '@/features/api-clients/usage-page';
import { z } from '@/lib/zod';

export const Route = createFileRoute('/_app/api-clients/usage')({
  validateSearch: z.object({
    client: z.string().optional(),
    // The router reads search values as JSON: `?days=7` typed or shared is
    // the number 7, while the page's own links write the string ("7").
    days: z.coerce
      .string<UsageRange | number>()
      .pipe(z.enum(usageRanges))
      .catch('30'),
  }),
  // Usage is its own switch (USAGE=off), and needs the clients' too.
  beforeLoad: async (options) => {
    await requireFeature('apiClients')(options);
    await requireFeature('usage')(options);
  },
  component: function Usage() {
    const search = Route.useSearch();
    return <UsagePage client={search.client} days={search.days} />;
  },
});
