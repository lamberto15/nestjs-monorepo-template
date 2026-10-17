import { NetworkIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import type { NavContribution } from '@/nav';

// Access administration (docs/permissions.md): each page behind the
// permission its changes need. The API decides either way.
export default [
  {
    group: 'administration',
    order: 10,
    to: '/access/users',
    label: 'access:nav.users',
    icon: UsersIcon,
    permission: 'Access.manageUsers',
  },
  {
    group: 'administration',
    order: 20,
    to: '/access/roles',
    label: 'access:nav.roles',
    icon: ShieldCheckIcon,
    permission: 'Access.manageRoles',
  },
  {
    group: 'administration',
    order: 30,
    to: '/access/teams',
    label: 'access:nav.teams',
    icon: NetworkIcon,
    permission: 'Access.manageTeams',
  },
] satisfies NavContribution[];
