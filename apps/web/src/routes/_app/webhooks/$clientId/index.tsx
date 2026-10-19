import { createFileRoute } from '@tanstack/react-router';
import { EndpointsPage } from '@/features/webhooks/endpoints-page';
import { requireWebhooks } from '@/features/webhooks/gate';

export const Route = createFileRoute('/_app/webhooks/$clientId/')({
  beforeLoad: requireWebhooks(),
  component: function Endpoints() {
    const { clientId } = Route.useParams();
    return <EndpointsPage clientId={clientId} />;
  },
});
