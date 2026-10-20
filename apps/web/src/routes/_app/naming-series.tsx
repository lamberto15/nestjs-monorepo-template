import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { NamingSeriesPage } from '@/features/naming-series/naming-series-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/naming-series')({
  beforeLoad: requirePermission('Access.manageNamingSeries'),
  component: NamingSeriesPage,
});
