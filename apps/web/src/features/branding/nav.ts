import { PaletteIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default {
  group: 'configuration',
  order: 20,
  to: '/branding',
  label: 'branding:nav',
  icon: PaletteIcon,
  permission: 'Access.manageSettings',
} satisfies NavContribution;
