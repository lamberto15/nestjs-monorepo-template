import { createFileRoute } from '@tanstack/react-router';
import { TransfersPage } from '@/features/transfer/transfers-page';

export const Route = createFileRoute('/_app/transfers/')({
  component: TransfersPage,
});
