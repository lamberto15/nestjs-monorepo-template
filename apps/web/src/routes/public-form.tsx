import { createFileRoute } from '@tanstack/react-router';
import { PublicFormPage } from '@/features/forms/public-page';

// A public form's link (docs/forms.md, "Public forms"): no sign-in, the
// token in the URL's fragment, so it reaches no server log.
export const Route = createFileRoute('/public-form')({
  staticData: { title: 'forms:public.title' },
  component: PublicFormPage,
});
