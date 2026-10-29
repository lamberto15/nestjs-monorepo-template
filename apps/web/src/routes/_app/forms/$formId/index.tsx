import { createFileRoute } from '@tanstack/react-router';
import { FormBuilder } from '@/features/forms/form-builder';

export const Route = createFileRoute('/_app/forms/$formId/')({
  component: function Builder() {
    const { formId } = Route.useParams();
    return <FormBuilder formId={formId} />;
  },
});
