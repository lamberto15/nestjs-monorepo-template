import { createFileRoute, redirect } from '@tanstack/react-router';
import { settingsQuery } from '@/features/settings/settings';
import { AnalyticsPage } from '@/features/analytics/analytics-page';
import { z } from '@/lib/zod';
import { clearAnalyticsFile } from '@/features/analytics/handoff';

export const Route = createFileRoute('/_app/analytics')({
  validateSearch: z.object({
    transferId: z.string().min(1).optional().catch(undefined),
    account: z.boolean().optional().catch(undefined),
  }),
  beforeLoad: async ({ context }) => {
    const settings = await context.queryClient
      .ensureQueryData(settingsQuery)
      .catch(() => []);
    if (
      !settings.some(
        (setting) =>
          setting.key === 'analytics.browser.enabled' && setting.value === true,
      )
    ) {
      clearAnalyticsFile();
      throw redirect({ to: '/' });
    }
  },
  component: function Analytics() {
    const search = Route.useSearch();
    return (
      <AnalyticsPage
        transferId={search.transferId}
        accountExport={search.account}
      />
    );
  },
});
