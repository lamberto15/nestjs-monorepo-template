import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { CustomFieldsPage } from '@/features/custom-fields/custom-fields-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/custom-fields')({
  beforeLoad: requirePermission('Access.manageCustomFields'),
  component: CustomFieldsPage,
});
