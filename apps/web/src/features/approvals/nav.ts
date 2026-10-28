import { ClipboardCheckIcon, ClipboardListIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';
import { useApprovalCount } from './use-approval-count';

export default [
  {
    group: 'home',
    order: 20,
    to: '/approvals',
    label: 'approvals:nav.title',
    icon: ClipboardCheckIcon,
    badge: useApprovalCount,
  },
  {
    group: 'configuration',
    order: 60,
    to: '/approval-policies',
    label: 'approvals:nav.policies',
    icon: ClipboardListIcon,
    permission: 'Approval.managePolicies',
  },
] satisfies NavContribution[];
