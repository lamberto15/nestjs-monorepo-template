import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { TeamsPage } from '@/features/access/teams-page';

export const Route = createFileRoute('/_app/access/teams/')({
  beforeLoad: requirePermission('Access.manageTeams'),
  component: TeamsPage,
});
