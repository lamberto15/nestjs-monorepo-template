import { KeyRoundIcon, ChartColumnIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default [
  {
    group: 'administration',
    order: 40,
    to: '/api-clients',
    label: 'api-clients:nav.title',
    icon: KeyRoundIcon,
    feature: 'apiClients',
    permission: 'Access.manageClients',
  },
  {
    group: 'administration',
    order: 41,
    to: '/api-clients/usage',
    label: 'api-clients:nav.usage',
    icon: ChartColumnIcon,
    feature: 'usage',
    permission: 'Access.manageClients',
  },
] satisfies NavContribution[];
