import { createFileRoute } from '@tanstack/react-router';
import { requireOpsOperator } from '@/features/ops/gate';
import { OpsPage } from '@/features/ops/ops-page';

export const Route = createFileRoute('/_app/ops/')({
  beforeLoad: requireOpsOperator,
  component: OpsPage,
});
