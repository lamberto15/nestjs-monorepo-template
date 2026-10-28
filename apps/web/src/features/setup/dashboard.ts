import { lazy } from 'react';
import type { DashboardContribution } from '@/features/dashboard/registry';

export default {
  cards: [
    {
      id: 'setup',
      label: 'setup:title',
      order: 5,
      component: lazy(() =>
        import('./setup-card').then((m) => ({ default: m.SetupCard })),
      ),
    },
  ],
} satisfies DashboardContribution;
