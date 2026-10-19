import { createFileRoute } from '@tanstack/react-router';
import { EndpointDetail } from '@/features/webhooks/endpoint-detail';
import { requireWebhooks } from '@/features/webhooks/gate';

export const Route = createFileRoute('/_app/webhooks/$clientId/$id')({
  beforeLoad: requireWebhooks(),
  component: function Detail() {
    const { clientId, id } = Route.useParams();
    return <EndpointDetail clientId={clientId} id={id} />;
  },
});
