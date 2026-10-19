import { Columns3Icon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 310,
  to: '/custom-fields',
  label: 'custom-fields:nav',
  icon: Columns3Icon,
  permission: 'Access.manageCustomFields',
} satisfies NavContribution;
