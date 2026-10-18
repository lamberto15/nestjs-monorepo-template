import { createFileRoute } from '@tanstack/react-router';
import { requirePermission, usersReaders } from '@/features/access/gate';
import { UsersPage } from '@/features/access/users-page';

export const Route = createFileRoute('/_app/access/users')({
  beforeLoad: requirePermission(...usersReaders),
  component: UsersPage,
});
