import { KeyRoundIcon, ChartColumnIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

export default [
  {
    group: 'developers',
    order: 10,
    to: '/api-clients',
    label: 'api-clients:nav.title',
    icon: KeyRoundIcon,
    feature: 'apiClients',
    permission: 'Access.manageClients',
  },
  {
    group: 'developers',
    order: 20,
    to: '/api-clients/usage',
    label: 'api-clients:nav.usage',
    icon: ChartColumnIcon,
    feature: 'usage',
    permission: 'Access.manageClients',
  },
] satisfies NavContribution[];
