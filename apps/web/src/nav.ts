import type { LucideIcon } from 'lucide-react';
import { LayoutDashboardIcon, StickyNoteIcon } from 'lucide-react';
import type { FeatureName, Permission } from '@/lib/features';
import type { FileRoutesByTo } from '@/routeTree.gen';

export type NavItem = {
  to: Extract<keyof FileRoutesByTo, string>;
  /** An i18n key (common namespace). */
  label: string;
  icon: LucideIcon;
  /** Shown only when this switch is on (`GET /v1/features`). */
  feature?: FeatureName;
  /** Shown only with this permission, `Subject.action` (`me.can`). */
  permission?: Permission;
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
