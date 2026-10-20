import { ClipboardCheckIcon, ClipboardListIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';
import { useApprovalCount } from './use-approval-count';

export default [
  {
    group: 'workspace',
    order: 60,
    to: '/approvals',
    label: 'approvals:nav.title',
    icon: ClipboardCheckIcon,
    badge: useApprovalCount,
  },
  {
    group: 'administration',
    order: 43,
    to: '/approval-policies',
    label: 'approvals:nav.policies',
    icon: ClipboardListIcon,
    permission: 'Approval.managePolicies',
  },
] satisfies NavContribution[];
