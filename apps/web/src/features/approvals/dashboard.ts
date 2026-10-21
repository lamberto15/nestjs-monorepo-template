import { ClipboardCheckIcon } from 'lucide-react';
import { lazy } from 'react';
import type { DashboardContribution } from '@/features/dashboard/registry';

export default {
  cards: [
    {
      id: 'approvals',
      order: 10,
      component: lazy(() =>
        import('./dashboard-cards').then((m) => ({
          default: m.PendingApprovalsCard,
        })),
      ),
    },
  ],
  actions: [
    {
      to: '/approvals',
      order: 10,
      label: 'approvals:nav.title',
      icon: ClipboardCheckIcon,
    },
  ],
} satisfies DashboardContribution;
