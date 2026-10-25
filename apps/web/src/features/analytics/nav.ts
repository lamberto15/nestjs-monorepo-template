import { ChartNoAxesCombinedIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'workspace',
  order: 120,
  to: '/analytics',
  label: 'analytics:nav',
  icon: ChartNoAxesCombinedIcon,
  settingFlag: 'analytics.browser.enabled',
} satisfies NavContribution;
