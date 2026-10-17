import { createFileRoute } from '@tanstack/react-router';
import { ClientsPage } from '@/features/api-clients/clients-page';
import { requireFeature } from '@/features/api-clients/gate';

export const Route = createFileRoute('/_app/api-clients/')({
  beforeLoad: requireFeature('apiClients'),
  component: ClientsPage,
});
