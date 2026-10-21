import { FilePlusIcon } from 'lucide-react';
import { lazy } from 'react';
import type { DashboardContribution } from '@/features/dashboard/registry';

export default {
  cards: [
    {
      id: 'notes-recent',
      order: 40,
      permission: 'Note.read',
      component: lazy(() =>
        import('./dashboard-cards').then((m) => ({
          default: m.RecentNotesCard,
        })),
      ),
    },
    {
      id: 'notes-per-week',
      order: 50,
      wide: true,
      permission: 'Note.read',
      component: lazy(() =>
        import('./dashboard-chart').then((m) => ({
          default: m.NotesPerWeekCard,
        })),
      ),
    },
  ],
  actions: [
    {
      to: '/notes/new',
      order: 40,
      label: 'notes:dashboard.newNote',
      icon: FilePlusIcon,
      permission: 'Note.create',
    },
  ],
} satisfies DashboardContribution;
