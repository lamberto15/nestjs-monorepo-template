import { createFileRoute } from '@tanstack/react-router';
import { requirePermission, teamsReaders } from '@/features/access/gate';
import { TeamMembers } from '@/features/access/team-members';

export const Route = createFileRoute('/_app/access/teams/$teamId')({
  beforeLoad: requirePermission(...teamsReaders),
  component: TeamPage,
});

function TeamPage() {
  const { teamId } = Route.useParams();
  return <TeamMembers teamId={teamId} />;
}
