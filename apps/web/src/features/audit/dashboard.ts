import { ScrollTextIcon } from 'lucide-react';
import { lazy } from 'react';
import type { DashboardContribution } from '@/features/dashboard/registry';

export default {
  cards: [
    {
      id: 'audit',
      order: 30,
      permission: 'Access.readAudit',
      component: lazy(() =>
        import('./dashboard-cards').then((m) => ({
          default: m.RecentActivityCard,
        })),
      ),
    },
  ],
  actions: [
    {
      to: '/audit',
      order: 30,
      label: 'audit:nav.title',
      icon: ScrollTextIcon,
      permission: 'Access.readAudit',
    },
  ],
} satisfies DashboardContribution;
