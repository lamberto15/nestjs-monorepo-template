import { createFileRoute } from '@tanstack/react-router';
import { ImportPage } from '@/features/transfer/import-page';
import { z } from '@/lib/zod';

export const Route = createFileRoute('/_app/transfers/import')({
  validateSearch: z.object({ name: z.string().optional().catch(undefined) }),
  component: function Import() {
    return <ImportPage name={Route.useSearch().name} />;
  },
});
