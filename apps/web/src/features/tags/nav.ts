import { TagsIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 320,
  to: '/tags',
  label: 'tags:nav',
  icon: TagsIcon,
  permission: 'Access.manageTags',
} satisfies NavContribution;
