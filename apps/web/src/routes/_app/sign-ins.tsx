import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { SignInsPage } from '@/features/sign-ins/sign-ins-page';

export const Route = createFileRoute('/_app/sign-ins')({
  beforeLoad: requirePermission('Access.readAudit'),
  component: SignInsPage,
});
