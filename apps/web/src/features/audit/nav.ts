import { ScrollTextIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'security',
  order: 10,
  to: '/audit',
  label: 'audit:nav.title',
  icon: ScrollTextIcon,
  permission: 'Access.readAudit',
} satisfies NavContribution;
