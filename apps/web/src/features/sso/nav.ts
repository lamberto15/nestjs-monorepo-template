import { LockKeyholeIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'people',
  order: 40,
  to: '/sso',
  label: 'sso:nav',
  icon: LockKeyholeIcon,
  permission: 'Access.manageSso',
} satisfies NavContribution;
