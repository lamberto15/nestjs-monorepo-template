import { HourglassIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'security',
  order: 30,
  to: '/retention',
  label: 'retention:nav',
  icon: HourglassIcon,
  permission: 'Access.manageRetention',
} satisfies NavContribution;
