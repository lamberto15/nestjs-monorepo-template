import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { SsoPage } from '@/features/sso/sso-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/sso')({
  beforeLoad: requirePermission('Access.manageSso'),
  component: SsoPage,
});
