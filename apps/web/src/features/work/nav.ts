import { useInfiniteQuery } from '@tanstack/react-query';
import { ListTodoIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';
import { workQuery } from './api';

/** The first page's count beside the entry. */
const useWaiting = () =>
  useInfiniteQuery(workQuery).data?.pages[0]?.items.length;

export default {
  group: 'home',
  order: 5,
  to: '/work',
  label: 'work:nav.title',
  icon: ListTodoIcon,
  badge: useWaiting,
} satisfies NavContribution;
