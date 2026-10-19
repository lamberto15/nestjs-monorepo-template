import { createFileRoute } from '@tanstack/react-router';
import { WebhookClientsPage } from '@/features/webhooks/clients-page';
import { requireWebhooks } from '@/features/webhooks/gate';

export const Route = createFileRoute('/_app/webhooks/')({
  beforeLoad: requireWebhooks(),
  component: WebhookClientsPage,
});
