import { FileDownIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

// Anyone may start the exports and imports they are allowed (`GET /v1/data`);
// the page lists this browser's own.
export default {
  group: 'home',
  order: 30,
  to: '/transfers',
  label: 'transfer:nav',
  icon: FileDownIcon,
} satisfies NavContribution;
