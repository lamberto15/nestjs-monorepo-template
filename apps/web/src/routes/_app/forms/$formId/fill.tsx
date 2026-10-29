import { createFileRoute } from '@tanstack/react-router';
import { FillPage } from '@/features/forms/fill-page';

export const Route = createFileRoute('/_app/forms/$formId/fill')({
  component: function Fill() {
    const { formId } = Route.useParams();
    return <FillPage formId={formId} />;
  },
});
