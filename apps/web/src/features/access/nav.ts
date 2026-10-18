import { NetworkIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import { teamsReaders, usersReaders } from '@/features/access/gate';
import type { NavContribution } from '@/nav';

// Access administration (docs/permissions.md): each page for whoever may
// read it (the users and teams for several kinds of administrator, see
// gate.ts); what each may change is gated on the page. The API decides.
export default [
  {
    group: 'administration',
    order: 10,
    to: '/access/users',
    label: 'access:nav.users',
    icon: UsersIcon,
    permission: usersReaders,
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
    permission: teamsReaders,
  },
] satisfies NavContribution[];
