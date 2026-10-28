import { useQuery } from '@tanstack/react-query';
import { InboxIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';
import { unreadQuery } from './queries';

/** The unread count beside the entry: the bell's query, kept live by it. */
const useUnreadCount = () => useQuery(unreadQuery(false)).data?.unread;

export default {
  group: 'home',
  order: 10,
  to: '/notifications',
  label: 'notifications:nav.title',
  icon: InboxIcon,
  badge: useUnreadCount,
} satisfies NavContribution;
