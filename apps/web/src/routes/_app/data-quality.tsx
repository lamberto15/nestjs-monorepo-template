import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { DataQualityPage } from '@/features/data-quality/data-quality-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/data-quality')({
  beforeLoad: requirePermission('DataQuality.read'),
  component: DataQualityPage,
});
