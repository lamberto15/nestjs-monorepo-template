import { unwrap } from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import type { Gated } from '@/lib/features';
import type { FileRoutesByTo } from '@/routeTree.gen';

/**
 * One step of the organization setup checklist: a screen that already exists,
 * the permission that opens it, and a read of the tenant's real state that
 * says whether it is done. Nothing is stored: any administrator, on any
 * device, sees the same list. `done` is a read the step's permission allows.
 */
export type SetupStep = Gated & {
  id: string;
  to: Extract<keyof FileRoutesByTo, string>;
  /** Whether the tenant has done it; the label is `setup:steps.<id>`. */
  done: () => Promise<boolean>;
};

const nonEmpty = (read: Promise<{ items: unknown[] }>) =>
  read.then((page) => page.items.length > 0);

export const setupSteps: SetupStep[] = [
  {
    id: 'invite',
    to: '/access/users',
    permission: 'Access.manageUsers',
    // More than the administrator themself, or an invitation on its way.
    done: async () =>
      (
        await unwrap(
          api.GET('/v1/access/users', { params: { query: { limit: 2 } } }),
        )
      ).items.length > 1 ||
      (await nonEmpty(unwrap(api.GET('/v1/access/invitations')))),
  },
  {
    id: 'roles',
    to: '/access/roles',
    permission: 'Access.manageRoles',
    // A role made through the API: the built-in and seeded ones have a key.
    done: async () =>
      (await unwrap(api.GET('/v1/access/roles'))).items.some(
        (role) => role.key === null,
      ),
  },
  {
    id: 'units',
    to: '/access/organization',
    permission: 'Access.manageOrganizationalUnits',
    done: () => nonEmpty(unwrap(api.GET('/v1/access/organizational-units'))),
  },
  {
    id: 'branding',
    to: '/branding',
    permission: 'Access.manageSettings',
    done: async () => {
      const branding = await unwrap(api.GET('/v1/branding'));
      return Boolean(
        branding.primaryColor || branding.logoUrl || branding.mailFromName,
      );
    },
  },
  {
    id: 'tags',
    to: '/tags',
    permission: 'Access.manageTags',
    done: () =>
      nonEmpty(
        unwrap(api.GET('/v1/tags', { params: { query: { limit: 1 } } })),
      ),
  },
  {
    id: 'customFields',
    to: '/custom-fields',
    permission: 'Access.manageCustomFields',
    // The fields are listed per subject: any subject having one counts.
    done: async () => {
      const { items } = await unwrap(api.GET('/v1/custom-fields/subjects'));
      const found = await Promise.all(
        items.map(({ subject }) =>
          nonEmpty(
            unwrap(
              api.GET('/v1/custom-fields', { params: { query: { subject } } }),
            ),
          ),
        ),
      );
      return found.some(Boolean);
    },
  },
];
