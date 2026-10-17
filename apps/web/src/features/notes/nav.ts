import { StickyNoteIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'workspace',
  order: 100,
  to: '/notes',
  label: 'nav.notes',
  icon: StickyNoteIcon,
  permission: 'Note.read',
} satisfies NavContribution;
