import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { PolicyPage } from '@/features/approvals/policy-page';

export const Route = createFileRoute('/_app/approval-policies/$key')({
  beforeLoad: requirePermission('Approval.managePolicies'),
  component: Policy,
});

function Policy() {
  const { key } = Route.useParams();
  return <PolicyPage policyKey={key} />;
}
