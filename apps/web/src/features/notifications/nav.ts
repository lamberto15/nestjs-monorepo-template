import { InboxIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'workspace',
  order: 50,
  to: '/notifications',
  label: 'notifications:nav.title',
  icon: InboxIcon,
} satisfies NavContribution;
