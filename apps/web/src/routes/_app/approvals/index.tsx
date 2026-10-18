import { createFileRoute } from '@tanstack/react-router';
import { tabs } from '@/features/approvals/api';
import { InboxPage } from '@/features/approvals/inbox-page';
import { z } from '@/lib/zod';

// The tab is in the URL, so a link opens "Requested by me" and back works.
export const Route = createFileRoute('/_app/approvals/')({
  validateSearch: z.object({ tab: z.enum(tabs).optional().catch(undefined) }),
  component: Inbox,
});

function Inbox() {
  const { tab } = Route.useSearch();
  return <InboxPage tab={tab ?? 'mine'} />;
}
