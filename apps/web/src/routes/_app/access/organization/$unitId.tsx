import { createFileRoute } from '@tanstack/react-router';
import { requirePermission, unitsReaders } from '@/features/access/gate';
import { UnitMembers } from '@/features/access/unit-members';

export const Route = createFileRoute('/_app/access/organization/$unitId')({
  beforeLoad: requirePermission(...unitsReaders),
  component: UnitPage,
});

function UnitPage() {
  const { unitId } = Route.useParams();
  return <UnitMembers unitId={unitId} />;
}
