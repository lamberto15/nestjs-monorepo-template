import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { TagsPage } from '@/features/tags/tags-page';

// Hiding the menu entry is for the user; the route refuses too.
export const Route = createFileRoute('/_app/tags')({
  beforeLoad: requirePermission('Access.manageTags'),
  component: TagsPage,
});
