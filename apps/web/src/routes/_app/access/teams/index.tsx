import { createFileRoute } from '@tanstack/react-router';
import { requirePermission, teamsReaders } from '@/features/access/gate';
import { TeamsPage } from '@/features/access/teams-page';

export const Route = createFileRoute('/_app/access/teams/')({
  beforeLoad: requirePermission(...teamsReaders),
  component: TeamsPage,
});
