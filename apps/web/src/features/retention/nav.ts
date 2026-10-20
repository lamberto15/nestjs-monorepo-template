import { HourglassIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 340,
  to: '/retention',
  label: 'retention:nav',
  icon: HourglassIcon,
  permission: 'Access.manageRetention',
} satisfies NavContribution;
