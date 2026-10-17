import { unwrap } from '@nestjs-monorepo-template/api-client';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  Catalog,
  Permission,
  RequestPermission,
} from '@/features/access/permissions';

/**
 * The access API (docs/permissions.md, docs/tenancy.md "Accounts and
 * sessions"). Its catalog, roles and users answers carry no response schema
 * in the OpenAPI document, so the client types them as nothing: the shapes
 * below are the API's (AccessAdminService.listRoles/listUsers,
 * PermissionCatalog.view), read as such.
 *
 * Who may call what (AccessPolicy):
 * - GET catalog, roles, users, teams: `open` (any of manageRoles,
 *   manageUsers, manageClients, readAudit)
 * - roles: manageRoles; users, invitations: manageUsers; teams: manageTeams
 * - impersonate: Access.impersonate (+ IMPERSONATION on)
 * Never while impersonating. Hiding in the UI is a courtesy: the API decides.
 */

export interface Role {
  id: string;
  key: string | null;
  name: string;
  description: string;
  /** Built in (Administrator): never changed or deleted. */
  system: boolean;
  permissions: Permission[];
  members: number;
  createdAt: string;
  updatedAt: string;
}

/** A role given to someone, until `expiresAt` (null: for good). */
export interface Grant {
  roleId: string;
  expiresAt: string | null;
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  /** The membership in this tenant. */
  active: boolean;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
  roleIds: string[];
  roles: Grant[];
  teamIds: string[];
}

export interface MembersPage {
  items: Member[];
  page?: number;
  nextPage?: number | null;
  pageCount?: number;
  total?: number;
}

export interface Team {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  members: number;
  createdAt: string;
  updatedAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  name: string | null;
  roleIds: string[];
  teamIds: string[];
  invitedBy: string;
  expired: boolean;
  expiresAt: string;
  createdAt: string;
}

/** A call whose answer the OpenAPI document doesn't describe (see above). */
async function untyped<T>(
  call: Promise<{ data?: unknown; response: Response }>,
): Promise<T> {
  return (await unwrap(call)) as T;
}

export const accessKeys = {
  all: ['access'] as const,
  catalog: ['access', 'catalog'] as const,
  roles: ['access', 'roles'] as const,
  members: ['access', 'members'] as const,
  allMembers: ['access', 'members', 'all'] as const,
  invitations: ['access', 'invitations'] as const,
  teams: ['access', 'teams'] as const,
};

export const catalogQuery = queryOptions({
  queryKey: accessKeys.catalog,
  queryFn: () => untyped<Catalog>(api.GET('/v1/access/catalog')),
  staleTime: 10 * 60_000,
});

export const rolesQuery = queryOptions({
  queryKey: accessKeys.roles,
  queryFn: async () =>
    (await untyped<{ items: Role[] }>(api.GET('/v1/access/roles'))).items,
});

export const teamsQuery = queryOptions({
  queryKey: accessKeys.teams,
  queryFn: async () => (await unwrap(api.GET('/v1/access/teams'))).items,
});

export const invitationsQuery = queryOptions({
  queryKey: accessKeys.invitations,
  queryFn: async () =>
    (await unwrap(api.GET('/v1/access/invitations'))).items as Invitation[],
});

export const MEMBERS_PER_PAGE = 20;

/** One page of the members, newest first; `q` narrows by address. */
export function membersQuery(page: number, q: string) {
  return queryOptions({
    queryKey: [...accessKeys.members, { page, q }],
    queryFn: () =>
      untyped<MembersPage>(
        api.GET('/v1/access/users', {
          params: {
            query: {
              page,
              limit: MEMBERS_PER_PAGE,
              count: 'true',
              ...(q && { 'email.contains': q }),
            },
          },
        }),
      ),
  });
}

/**
 * Every member (a team's members, the people to add to it): the users list
 * has no team filter, so it is read whole, 100 a page (its maximum).
 */
export const allMembersQuery = queryOptions({
  queryKey: accessKeys.allMembers,
  queryFn: async () => {
    const items: Member[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await untyped<MembersPage>(
        api.GET('/v1/access/users', {
          params: { query: { page, limit: 100, sort: 'email' } },
        }),
      );
      items.push(...data.items);
      if (!data.nextPage) break;
    }
    return items;
  },
});

/** The request body of a role (create and replace). */
export interface RoleBody {
  name: string;
  description?: string;
  permissions: RequestPermission[];
}

export async function createRole(body: RoleBody) {
  return untyped<{ id: string }>(api.POST('/v1/access/roles', { body }));
}

export async function updateRole(id: string, body: RoleBody) {
  await api.PATCH('/v1/access/roles/{id}', {
    params: { path: { id } },
    body,
  });
}

export async function deleteRole(id: string) {
  await api.DELETE('/v1/access/roles/{id}', { params: { path: { id } } });
}

/** What changes of a membership; only what is sent changes. */
export interface MemberChanges {
  active?: boolean;
  roleIds?: string[];
  /** Replaces every end date: a role not listed never ends. */
  roleExpiresAt?: Record<string, string>;
  teamIds?: string[];
}

export async function updateMember(id: string, body: MemberChanges) {
  await api.PATCH('/v1/access/users/{id}', {
    params: { path: { id } },
    body,
  });
}

export interface InvitationBody {
  email: string;
  name?: string;
  roleIds: string[];
  roleExpiresAt?: Record<string, string>;
  teamIds?: string[];
}

/** Invites someone; a pending invitation to the same address is replaced. */
export async function invite(body: InvitationBody) {
  return unwrap(api.POST('/v1/access/users', { body }));
}

export async function revokeInvitation(id: string) {
  await api.DELETE('/v1/access/invitations/{id}', {
    params: { path: { id } },
  });
}

export async function createTeam(body: {
  name: string;
  parentId?: string | null;
}) {
  return unwrap(api.POST('/v1/access/teams', { body }));
}

export async function updateTeam(
  id: string,
  body: { name?: string; parentId?: string | null },
) {
  return unwrap(
    api.PATCH('/v1/access/teams/{id}', { params: { path: { id } }, body }),
  );
}

export async function deleteTeam(id: string) {
  await api.DELETE('/v1/access/teams/{id}', { params: { path: { id } } });
}

/** Everything the access pages show, after a change. */
export function invalidateAccess(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: accessKeys.all });
}

/**
 * The role grants of a member as `roleExpiresAt`: every end date kept,
 * since the API replaces all of them when the map is sent.
 */
export function expiriesOf(grants: readonly Grant[]): Record<string, string> {
  return Object.fromEntries(
    grants.flatMap((grant) =>
      grant.expiresAt ? [[grant.roleId, grant.expiresAt]] : [],
    ),
  );
}
