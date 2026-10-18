import { CalendarClockIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

// REPORTS=off leaves the routes out (404): the entry follows the switch.
export default {
  group: 'workspace',
  order: 120,
  to: '/reports',
  label: 'reports:nav',
  icon: CalendarClockIcon,
  feature: 'reports',
} satisfies NavContribution;
