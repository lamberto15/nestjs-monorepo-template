import { createFileRoute } from '@tanstack/react-router';
import { requirePermission } from '@/features/access/gate';
import { UsersPage } from '@/features/access/users-page';

export const Route = createFileRoute('/_app/access/users')({
  beforeLoad: requirePermission('Access.manageUsers'),
  component: UsersPage,
});
