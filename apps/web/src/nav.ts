import type { LucideIcon } from 'lucide-react';
import { LayoutDashboardIcon, StickyNoteIcon } from 'lucide-react';
import type { FileRoutesByTo } from '@/routeTree.gen';

export type NavItem = {
  to: Extract<keyof FileRoutesByTo, string>;
  /** An i18n key (common namespace). */
  label: string;
  icon: LucideIcon;
  /** Shown only when this feature is on (filtering comes later). */
  feature?: string;
  /** Shown only with this permission (filtering comes later). */
  permission?: string;
};

export const nav: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboardIcon },
  {
    to: '/notes',
    label: 'nav.notes',
    icon: StickyNoteIcon,
    permission: 'Note.read',
  },
];
