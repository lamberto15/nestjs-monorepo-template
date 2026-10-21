import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '@/features/dashboard/page';

export const Route = createFileRoute('/_app/')({
  component: Dashboard,
});
