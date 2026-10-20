import { createFileRoute } from '@tanstack/react-router';
import { requireMailOperator } from '@/features/suppressions/gate';
import { SuppressionsPage } from '@/features/suppressions/suppressions-page';

export const Route = createFileRoute('/_app/mail-suppressions')({
  beforeLoad: requireMailOperator,
  component: SuppressionsPage,
});
