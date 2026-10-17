import { createFileRoute } from '@tanstack/react-router';
import { Inbox } from '@/features/notifications/inbox';

export const Route = createFileRoute('/_app/notifications')({
  component: Inbox,
});
