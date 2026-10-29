import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { AutomationsPage } from '@/features/automations/automations-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/automations')({
  beforeLoad: requirePermission('AutomationRule.read'),
  component: AutomationsPage,
});
