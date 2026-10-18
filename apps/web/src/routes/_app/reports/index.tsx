import { createFileRoute } from '@tanstack/react-router';
import { requireFeature } from '@/features/api-clients/gate';
import { ReportsPage } from '@/features/reports/reports-page';

// REPORTS=off leaves the module out (404): no page either.
export const Route = createFileRoute('/_app/reports/')({
  beforeLoad: requireFeature('reports'),
  component: ReportsPage,
});
