import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { TeamMembers } from '@/features/access/team-members';

export const Route = createFileRoute('/_app/access/teams/$teamId')({
  beforeLoad: requirePermission('Access.manageTeams'),
  component: TeamPage,
});

function TeamPage() {
  const { teamId } = Route.useParams();
  return <TeamMembers teamId={teamId} />;
}
