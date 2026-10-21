import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { BrandingPage } from '@/features/branding/branding-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/branding')({
  beforeLoad: requirePermission('Access.manageSettings'),
  component: BrandingPage,
});
