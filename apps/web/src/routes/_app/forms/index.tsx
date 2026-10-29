import { createFileRoute } from '@tanstack/react-router';
import { FormsPage } from '@/features/forms/forms-page';

// forms.enabled off: the page says so (the API answers 404 meanwhile).
export const Route = createFileRoute('/_app/forms/')({
  component: FormsPage,
});
