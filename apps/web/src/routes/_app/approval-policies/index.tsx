import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { PoliciesPage } from '@/features/approvals/policies-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/approval-policies/')({
  beforeLoad: requirePermission('Approval.managePolicies'),
  component: PoliciesPage,
});
