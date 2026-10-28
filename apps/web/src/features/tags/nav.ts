import { TagsIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'configuration',
  order: 40,
  to: '/tags',
  label: 'tags:nav',
  icon: TagsIcon,
  permission: 'Access.manageTags',
} satisfies NavContribution;
