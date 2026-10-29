import { createFileRoute } from '@tanstack/react-router';
import { SubmissionsPage } from '@/features/forms/fill-page';

export const Route = createFileRoute('/_app/forms/$formId/submissions')({
  component: function Submissions() {
    const { formId } = Route.useParams();
    return <SubmissionsPage formId={formId} />;
  },
});
