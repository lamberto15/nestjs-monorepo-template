import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { AuditPage } from '@/features/audit/audit-page';

export const Route = createFileRoute('/_app/audit')({
  beforeLoad: requirePermission('Access.readAudit'),
  component: AuditPage,
});
