import { ShieldCheckIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 340,
  to: '/sso',
  label: 'sso:nav',
  icon: ShieldCheckIcon,
  permission: 'Access.manageSso',
} satisfies NavContribution;
