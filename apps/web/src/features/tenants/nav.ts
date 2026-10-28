import { BuildingIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'platform',
  order: 10,
  to: '/tenants',
  label: 'tenants:nav',
  icon: BuildingIcon,
  permission: 'Access.manageTenants',
  operator: true,
} satisfies NavContribution;
