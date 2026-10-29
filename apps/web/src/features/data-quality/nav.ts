import { ClipboardCheckIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'configuration',
  order: 45,
  to: '/data-quality',
  label: 'data-quality:nav',
  icon: ClipboardCheckIcon,
  permission: 'DataQuality.read',
} satisfies NavContribution;
