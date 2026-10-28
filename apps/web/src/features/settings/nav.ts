import { SlidersHorizontalIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'configuration',
  order: 10,
  to: '/settings',
  label: 'settings:nav',
  icon: SlidersHorizontalIcon,
  permission: 'Access.manageSettings',
} satisfies NavContribution;
