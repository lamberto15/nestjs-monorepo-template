import { WorkflowIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'configuration',
  order: 45,
  to: '/automations',
  label: 'automations:nav',
  icon: WorkflowIcon,
  permission: 'AutomationRule.read',
} satisfies NavContribution;
