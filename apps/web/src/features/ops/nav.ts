import { ActivityIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'platform',
  order: 20,
  to: '/ops',
  label: 'ops:nav',
  icon: ActivityIcon,
  permission: 'Ops.view',
  operatorTenant: true,
} satisfies NavContribution;
