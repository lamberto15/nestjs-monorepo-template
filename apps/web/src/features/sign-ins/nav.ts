import { HistoryIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'security',
  order: 20,
  to: '/sign-ins',
  label: 'sign-ins:nav.title',
  icon: HistoryIcon,
  permission: 'Access.readAudit',
} satisfies NavContribution;
