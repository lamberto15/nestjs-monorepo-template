import { HashIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 330,
  to: '/naming-series',
  label: 'naming-series:nav',
  icon: HashIcon,
  permission: 'Access.manageNamingSeries',
} satisfies NavContribution;
