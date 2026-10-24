import { InboxIcon } from 'lucide-react';
import { lazy } from 'react';
import type { DashboardContribution } from '@/features/dashboard/registry';

export default {
  cards: [
    {
      id: 'notifications',
      label: 'notifications:dashboard.title',
      order: 20,
      component: lazy(() =>
        import('./dashboard-cards').then((m) => ({
          default: m.UnreadNotificationsCard,
        })),
      ),
    },
  ],
  actions: [
    {
      to: '/notifications',
      order: 20,
      label: 'notifications:nav.title',
      icon: InboxIcon,
    },
  ],
} satisfies DashboardContribution;
