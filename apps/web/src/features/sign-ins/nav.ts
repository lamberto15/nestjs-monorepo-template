import { LogInIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 41,
  to: '/sign-ins',
  label: 'sign-ins:nav.title',
  icon: LogInIcon,
  permission: 'Access.readAudit',
} satisfies NavContribution;
