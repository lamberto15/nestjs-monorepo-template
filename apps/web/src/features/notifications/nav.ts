import { InboxIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'home',
  order: 10,
  to: '/notifications',
  label: 'notifications:nav.title',
  icon: InboxIcon,
} satisfies NavContribution;
