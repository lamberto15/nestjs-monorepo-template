import { createFileRoute, redirect } from '@tanstack/react-router';
import { SendersPage } from '@/features/webhooks/senders-page';

export const Route = createFileRoute('/_app/webhooks/senders')({
  // For the user's sake only: the API refuses without Access.manageClients.
  beforeLoad: ({ context }) => {
    if (context.me.can['Access.manageClients'] !== true) {
      throw redirect({ to: '/' });
    }
  },
  component: SendersPage,
});
