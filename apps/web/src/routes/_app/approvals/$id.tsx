import { createFileRoute } from '@tanstack/react-router';
import { DetailPage } from '@/features/approvals/detail-page';

export const Route = createFileRoute('/_app/approvals/$id')({
  component: Detail,
});

function Detail() {
  const { id } = Route.useParams();
  return <DetailPage id={id} />;
}
