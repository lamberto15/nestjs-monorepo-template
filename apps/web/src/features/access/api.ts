import {
  etagOf,
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { refsKey } from '@/lib/list-refs';
import { peopleKey, unitsKey } from '@/lib/people';
import { meQuery } from '@/lib/session';

/**
 * The access API (docs/permissions.md, docs/tenancy.md "Accounts and
 * sessions"), typed by the client: the shapes below are its answers.
 *
 * Who may call what (AccessPolicy):
 * - GET catalog, roles, users, units, principals: `open` (any of
 *   manageRoles, manageUsers, manageClients, manageOrganizationalUnits, impersonate,
 *   readAudit)
 * - roles: manageRoles; users, invitations: manageUsers; units: manageOrganizationalUnits
 * - impersonate: Access.impersonate (+ IMPERSONATION on)
 * Never while impersonating. Hiding in the UI is a courtesy: the API decides.
 */

export type Role = GetResponse<'/v1/access/roles'>['items'][number];

export type MembersPage = GetResponse<'/v1/access/users'>;
export type Member = MembersPage['items'][number];

/** A role given to someone, until `expiresAt` (null: for good). */
export type Grant = Member['roles'][number];

export type Unit =
  GetResponse<'/v1/access/organizational-units'>['items'][number];

export type Invitation = GetResponse<'/v1/access/invitations'>['items'][number];

type JsonBody<T> = T extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

export const accessKeys = {
  all: ['access'] as const,
  catalog: ['access', 'catalog'] as const,
  roles: ['access', 'roles'] as const,
  members: ['access', 'members'] as const,
  invitations: ['access', 'invitations'] as const,
  units: ['access', 'units'] as const,
};

/**
 * The catalog's labels come in the request's language (Accept-Language, the
 * UI's): one cache entry per language, so switching it reads them again.
 */
export function catalogQuery(language: string) {
  return queryOptions({
    queryKey: [...accessKeys.catalog, language],
    queryFn: () => unwrap(api.GET('/v1/access/catalog')),
    staleTime: 10 * 60_000,
  });
}

export const rolesQuery = queryOptions({
  queryKey: accessKeys.roles,
  queryFn: async () => (await unwrap(api.GET('/v1/access/roles'))).items,
});

/** One role, with its permissions and member count (404: none such). */
/**
 * One role with the ETag it came with: the `If-Match` of its save, so a role
 * another administrator saved meanwhile is refused (412), not overwritten.
 */
export function roleQuery(id: string) {
  return queryOptions({
    queryKey: [...accessKeys.roles, id],
    queryFn: async () => {
      const result = await api.GET('/v1/access/roles/{id}', {
        params: { path: { id } },
      });
      return {
        role: await unwrap(Promise.resolve(result)),
        etag: etagOf(result),
      };
    },
  });
}

export const unitsQuery = queryOptions({
  queryKey: accessKeys.units,
  queryFn: async () =>
    (await unwrap(api.GET('/v1/access/organizational-units'))).items,
});

export const invitationsQuery = queryOptions({
  queryKey: accessKeys.invitations,
  queryFn: async () => (await unwrap(api.GET('/v1/access/invitations'))).items,
});

/** One member, with their role grants and units (404: not in this tenant). */
export function memberQuery(id: string) {
  return queryOptions({
    queryKey: [...accessKeys.members, 'one', id],
    queryFn: () =>
      unwrap(api.GET('/v1/access/users/{id}', { params: { path: { id } } })),
  });
}

/** A unit's current members (`GET .../{id}/members`): who, and member or lead. */
export type UnitMember =
  GetResponse<'/v1/access/organizational-units/{id}/members'>['items'][number];

export type UnitType = Unit['type'];

export function unitMembersQuery(unitId: string) {
  return queryOptions({
    queryKey: [...accessKeys.members, 'unit', unitId],
    // The API lists ended memberships too (history); those can't be changed.
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/access/organizational-units/{id}/members', {
            params: { path: { id: unitId } },
          }),
        )
      ).items.filter(
        (member) =>
          member.validTo === null || new Date(member.validTo) > new Date(),
      ),
  });
}

/**
 * A role's name and description mirror the API's `maxLength`;
 * lib/limits.test.ts compares them with openapi.json.
 */
export const ROLE_LIMITS = { name: 80, description: 500 } as const;

/** The request body of a role (create and replace). */
export type RoleBody = JsonBody<paths['/v1/access/roles']['post']>;

export async function createRole(body: RoleBody) {
  return unwrap(api.POST('/v1/access/roles', { body }));
}

export async function updateRole(id: string, body: RoleBody, etag?: string) {
  await api.PATCH('/v1/access/roles/{id}', {
    params: { path: { id }, header: etag ? { 'If-Match': etag } : {} },
    body,
  });
}

export async function deleteRole(id: string) {
  await api.DELETE('/v1/access/roles/{id}', { params: { path: { id } } });
}

/**
 * What changes of a membership; only what is sent changes. `roleExpiresAt`
 * replaces every end date: a role not listed never ends.
 */
export type MemberChanges = JsonBody<paths['/v1/access/users/{id}']['patch']>;

export async function updateMember(id: string, body: MemberChanges) {
  await api.PATCH('/v1/access/users/{id}', {
    params: { path: { id } },
    body,
  });
}

/**
 * An invitation's name mirrors the API's `maxLength`; lib/limits.test.ts
 * compares it with openapi.json.
 */
export const INVITATION_LIMITS = { name: 120 } as const;

/**
 * A unit's name mirrors the API's `maxLength`; lib/limits.test.ts compares
 * it with openapi.json.
 */
export const UNIT_LIMITS = { name: 120 } as const;

export type InvitationBody = JsonBody<paths['/v1/access/users']['post']>;
export type InvitationChanges = JsonBody<
  paths['/v1/access/invitations/{id}']['patch']
>;

/**
 * Invites (`send: true`, the link is mailed now) or prepares (`send: false`,
 * no link until `sendInvitation()`) a member; a pending invitation to the
 * same address is replaced.
 */
export async function invite(body: InvitationBody) {
  return unwrap(api.POST('/v1/access/users', { body }));
}

/**
 * Changes a pending invitation; a new address withdraws a sent link (it is
 * prepared again). With roles or an address, asks for a recent sign-in.
 */
export async function updateInvitation(id: string, body: InvitationChanges) {
  return unwrap(
    api.PATCH('/v1/access/invitations/{id}', {
      params: { path: { id } },
      body,
    }),
  );
}

/**
 * Sends a pending invitation: a prepared one its first link, a sent or
 * expired one a new link and expiry (the old one stops), its roles, their
 * ends and its units unchanged. Asks for a recent sign-in, which the
 * client's step-up middleware answers (lib/api.ts).
 */
export async function sendInvitation(id: string) {
  return unwrap(
    api.POST('/v1/access/invitations/{id}/send', {
      params: { path: { id } },
    }),
  );
}

export async function revokeInvitation(id: string) {
  await api.DELETE('/v1/access/invitations/{id}', {
    params: { path: { id } },
  });
}

export async function createUnit(body: {
  type: UnitType;
  name: string;
  parentId?: string | null;
}) {
  return unwrap(api.POST('/v1/access/organizational-units', { body }));
}

export async function updateUnit(
  id: string,
  body: { type?: UnitType; name?: string; parentId?: string | null },
) {
  return unwrap(
    api.PATCH('/v1/access/organizational-units/{id}', {
      params: { path: { id } },
      body,
    }),
  );
}

export async function deleteUnit(id: string) {
  await api.DELETE('/v1/access/organizational-units/{id}', {
    params: { path: { id } },
  });
}

export async function addUnitMember(
  id: string,
  body: {
    userId: string;
    role: UnitMember['role'];
    validFrom?: string;
    validTo?: string;
  },
) {
  return unwrap(
    api.POST('/v1/access/organizational-units/{id}/members', {
      params: { path: { id } },
      body,
    }),
  );
}

export async function changeUnitMember(
  id: string,
  userId: string,
  role: UnitMember['role'],
) {
  return unwrap(
    api.PATCH('/v1/access/organizational-units/{id}/members/{userId}', {
      params: { path: { id, userId } },
      body: { role },
    }),
  );
}

/**
 * Who would gain or lose reach (my units and below, units I lead and below)
 * if a unit changed, or a member's role did: a dry run, nothing changes
 * (docs/permissions.md, "Organization structure").
 */
export async function previewUnitChange(
  id: string,
  body: { type?: UnitType; name?: string; parentId?: string | null },
) {
  return unwrap(
    api.POST('/v1/access/organizational-units/{id}/impact', {
      params: { path: { id } },
      body,
    }),
  );
}

export async function previewUnitMemberChange(
  id: string,
  userId: string,
  role: UnitMember['role'],
) {
  return unwrap(
    api.POST('/v1/access/organizational-units/{id}/members/{userId}/impact', {
      params: { path: { id, userId } },
      body: { role },
    }),
  );
}

export type AccessImpact = Awaited<ReturnType<typeof previewUnitChange>>;

/** Why a member may or may not act on a subject or one of its records (docs/permissions.md, "Explaining access"). */
export type Explanation = GetResponse<'/v1/access/users/{id}/explanation'>;

export function explanationQuery(
  id: string,
  subject: string,
  recordId?: string,
) {
  return queryOptions({
    queryKey: [...accessKeys.members, 'explanation', id, subject, recordId],
    queryFn: () =>
      unwrap(
        api.GET('/v1/access/users/{id}/explanation', {
          params: { path: { id }, query: { subject, recordId } },
        }),
      ),
  });
}

/** Ends the membership (the API keeps it as history). */
export async function removeUnitMember(id: string, userId: string) {
  await api.DELETE('/v1/access/organizational-units/{id}/members/{userId}', {
    params: { path: { id, userId } },
  });
}

/**
 * Everything the access pages show, after a change, and what other pages
 * took from it: the unit names and the filters' unit and people options, the
 * people directory (a deactivated member leaves it), and the signed-in user's
 * own `can` (a role's permissions or a grant may be theirs).
 */
export function invalidateAccess(queryClient: QueryClient) {
  return Promise.all(
    [accessKeys.all, unitsKey, refsKey, peopleKey, meQuery.queryKey].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}
