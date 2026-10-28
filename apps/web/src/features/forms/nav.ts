import { ClipboardListIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

// Whoever may read forms; with forms.enabled off the page says so.
export default {
  group: 'workspace',
  order: 130,
  to: '/forms',
  label: 'forms:nav',
  icon: ClipboardListIcon,
  permission: 'Form.read',
} satisfies NavContribution;
