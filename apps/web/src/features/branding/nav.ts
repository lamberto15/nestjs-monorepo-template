import { PaletteIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'administration',
  order: 310,
  to: '/branding',
  label: 'branding:nav',
  icon: PaletteIcon,
  permission: 'Access.manageSettings',
} satisfies NavContribution;
