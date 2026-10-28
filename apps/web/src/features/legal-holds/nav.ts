import { GavelIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'security',
  order: 40,
  to: '/legal-holds',
  label: 'legal-holds:nav',
  icon: GavelIcon,
  permission: 'Access.manageLegalHolds',
} satisfies NavContribution;
