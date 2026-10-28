import { NetworkIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import { unitsReaders, usersReaders } from '@/features/access/gate';
import type { NavContribution } from '@/nav';

// Access administration (docs/permissions.md): each page for whoever may
// read it (the users and units for several kinds of administrator, see
// gate.ts); what each may change is gated on the page. The API decides.
export default [
  {
    group: 'people',
    order: 10,
    to: '/access/users',
    label: 'access:nav.users',
    icon: UsersIcon,
    permission: usersReaders,
  },
  {
    group: 'people',
    order: 20,
    to: '/access/roles',
    label: 'access:nav.roles',
    icon: ShieldCheckIcon,
    permission: 'Access.manageRoles',
  },
  {
    group: 'people',
    order: 30,
    to: '/access/organization',
    label: 'access:nav.units',
    icon: NetworkIcon,
    permission: unitsReaders,
  },
] satisfies NavContribution[];
