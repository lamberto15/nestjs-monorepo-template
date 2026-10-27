import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { refsKey } from '@/lib/list-refs';
import { peopleKey, teamsKey } from '@/lib/people';
import { meQuery } from '@/lib/session';

/**
 * The access API (docs/permissions.md, docs/tenancy.md "Accounts and
 * sessions"), typed by the client: the shapes below are its answers.
 *
 * Who may call what (AccessPolicy):
 * - GET catalog, roles, users, teams, principals: `open` (any of
 *   manageRoles, manageUsers, manageClients, manageTeams, impersonate,
 *   readAudit)
 * - roles: manageRoles; users, invitations: manageUsers; teams: manageTeams
 * - impersonate: Access.impersonate (+ IMPERSONATION on)
 * Never while impersonating. Hiding in the UI is a courtesy: the API decides.
 */

export type Role = GetResponse<'/v1/access/roles'>['items'][number];

export type MembersPage = GetResponse<'/v1/access/users'>;
export type Member = MembersPage['items'][number];

/** A role given to someone, until `expiresAt` (null: for good). */
export type Grant = Member['roles'][number];

export type Team = GetResponse<'/v1/access/teams'>['items'][number];

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
  teams: ['access', 'teams'] as const,
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
export function roleQuery(id: string) {
  return queryOptions({
    queryKey: [...accessKeys.roles, id],
    queryFn: () =>
      unwrap(api.GET('/v1/access/roles/{id}', { params: { path: { id } } })),
  });
}

export const teamsQuery = queryOptions({
  queryKey: accessKeys.teams,
  queryFn: async () => (await unwrap(api.GET('/v1/access/teams'))).items,
});

export const invitationsQuery = queryOptions({
  queryKey: accessKeys.invitations,
  queryFn: async () => (await unwrap(api.GET('/v1/access/invitations'))).items,
});

/** One member, with their role grants and teams (404: not in this tenant). */
export function memberQuery(id: string) {
  return queryOptions({
    queryKey: [...accessKeys.members, 'one', id],
    queryFn: () =>
      unwrap(api.GET('/v1/access/users/{id}', { params: { path: { id } } })),
  });
}

/**
 * A team's direct members (`?teamId=`), by address: read whole, 100 a page
 * (the list's maximum), since the page lists them all.
 */
export function teamMembersQuery(teamId: string) {
  return queryOptions({
    queryKey: [...accessKeys.members, 'team', teamId],
    queryFn: async () => {
      const items: Member[] = [];
      for (let page = 1; page <= 100; page++) {
        const data = await unwrap(
          api.GET('/v1/access/users', {
            params: { query: { teamId, page, limit: 100, sort: 'email' } },
          }),
        );
        items.push(...data.items);
        if (!data.nextPage) break;
      }
      return items;
    },
  });
}

/** The request body of a role (create and replace). */
export type RoleBody = JsonBody<paths['/v1/access/roles']['post']>;

export async function createRole(body: RoleBody) {
  return unwrap(api.POST('/v1/access/roles', { body }));
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

export type InvitationBody = JsonBody<paths['/v1/access/users']['post']>;

/** Invites someone; a pending invitation to the same address is replaced. */
export async function invite(body: InvitationBody) {
  return unwrap(api.POST('/v1/access/users', { body }));
}

/**
 * Sends a pending invitation again (expired or not): a new link and expiry,
 * its roles, their ends and its teams unchanged. Asks for a recent sign-in,
 * which the client's step-up middleware answers (lib/api.ts).
 */
export async function resendInvitation(id: string) {
  return unwrap(
    api.POST('/v1/access/invitations/{id}/resend', {
      params: { path: { id } },
    }),
  );
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

/**
 * Everything the access pages show, after a change, and what other pages
 * took from it: the team names and the filters' team and people options, the
 * people directory (a deactivated member leaves it), and the signed-in user's
 * own `can` (a role's permissions or a grant may be theirs).
 */
export function invalidateAccess(queryClient: QueryClient) {
  return Promise.all(
    [accessKeys.all, teamsKey, refsKey, peopleKey, meQuery.queryKey].map(
      (queryKey) => queryClient.invalidateQueries({ queryKey }),
    ),
  );
}
