import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { LegalHoldsPage } from '@/features/legal-holds/legal-holds-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/legal-holds')({
  beforeLoad: requirePermission('Access.manageLegalHolds'),
  component: LegalHoldsPage,
});
