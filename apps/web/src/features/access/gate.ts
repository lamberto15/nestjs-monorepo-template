import { redirect } from '@tanstack/react-router';
import type { Permission } from '@/lib/features';
import type { Me } from '@/lib/session';

/**
 * A route's `beforeLoad` that sends anyone without the permission to the
 * dashboard (`me` comes from the `_app` route's context). For the user's
 * sake only: the API refuses them anyway.
 */
export function requirePermission(permission: Permission) {
  return ({ context }: { context: { me: Me } }) => {
    if (context.me.can[permission] !== true) {
      throw redirect({ to: '/' });
    }
  };
}
