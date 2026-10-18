import { redirect } from '@tanstack/react-router';
import { holds, type Permission } from '@/lib/features';
import type { Me } from '@/lib/session';

/**
 * A route's `beforeLoad` that sends anyone holding none of the permissions
 * to the dashboard (`me` comes from the `_app` route's context). For the
 * user's sake only: the API refuses them anyway.
 */
export function requirePermission(...permissions: Permission[]) {
  return ({ context }: { context: { me: Me } }) => {
    if (!holds(context.me.can, permissions)) {
      throw redirect({ to: '/' });
    }
  };
}

/**
 * Who reads the users page: the API lists users to any access administrator
 * (AccessPolicy.open), so whoever manages teams sees who is in them and
 * whoever impersonates finds whom. Changing a member wants manageUsers.
 */
export const usersReaders = [
  'Access.manageUsers',
  'Access.manageTeams',
  'Access.impersonate',
] as const satisfies Permission[];

/**
 * Who reads the teams: those who manage them, and those who manage users
 * (a team's membership is the member's). Changing the tree wants manageTeams.
 */
export const teamsReaders = [
  'Access.manageTeams',
  'Access.manageUsers',
] as const satisfies Permission[];
