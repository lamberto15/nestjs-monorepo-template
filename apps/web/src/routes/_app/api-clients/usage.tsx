import { createFileRoute } from '@tanstack/react-router';
import { requireFeature } from '@/features/api-clients/gate';
import { UsagePage, usageRanges } from '@/features/api-clients/usage-page';
import { z } from '@/lib/zod';

export const Route = createFileRoute('/_app/api-clients/usage')({
  validateSearch: z.object({
    client: z.string().optional(),
    days: z.enum(usageRanges).catch('30'),
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
