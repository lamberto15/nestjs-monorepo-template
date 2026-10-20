import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { RetentionPage } from '@/features/retention/retention-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/retention')({
  beforeLoad: requirePermission('Access.manageRetention'),
  component: RetentionPage,
});
