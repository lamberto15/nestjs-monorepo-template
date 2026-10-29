import { createFileRoute } from '@tanstack/react-router';
import { WorkPage } from '@/features/work/work-page';

export const Route = createFileRoute('/_app/work')({
  component: WorkPage,
});
