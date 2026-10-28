import { Columns3Icon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'configuration',
  order: 30,
  to: '/custom-fields',
  label: 'custom-fields:nav',
  icon: Columns3Icon,
  permission: 'Access.manageCustomFields',
} satisfies NavContribution;
