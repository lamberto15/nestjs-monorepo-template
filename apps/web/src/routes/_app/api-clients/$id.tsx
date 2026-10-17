import { createFileRoute } from '@tanstack/react-router';
import { ClientDetail } from '@/features/api-clients/client-detail';
import { requireFeature } from '@/features/api-clients/gate';

export const Route = createFileRoute('/_app/api-clients/$id')({
  beforeLoad: requireFeature('apiClients'),
  component: function Detail() {
    const { id } = Route.useParams();
    return <ClientDetail id={id} />;
  },
});
