import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  etagOf,
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import { useFeatures, useMe } from '@/lib/features';
import { meQuery, tenantsQuery } from '@/lib/session';

export type TenantRow = GetResponse<'/v1/tenants'>['items'][number];

/** What a create sends: the tenant's name and slug, and its first administrator. */
export type CreateTenantBody = paths['/v1/tenants']['post'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/**
 * Every tenant (`GET /v1/tenants`). Only the operators may ask (anyone else
 * gets 403 `operator_required`): the app asks only once `/me` says the user
 * is one (`isOperator`).
 */
export const tenantsAdminQuery = queryOptions({
  queryKey: ['tenants', 'list'],
  queryFn: () => unwrap(api.GET('/v1/tenants')),
  retry: false,
});

/** What a PATCH changes: the name, the slug, `active`. */
export type TenantChanges = paths['/v1/tenants/{id}']['patch'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/**
 * One tenant (`GET /v1/tenants/{id}`) with the ETag it came with: the
 * `If-Match` of the next change, so a tenant another operator changed
 * meanwhile is refused (412) instead of overwritten.
 */
export const tenantQuery = (id: string) =>
  queryOptions({
    queryKey: ['tenants', 'one', id],
    queryFn: async () => {
      const result = await api.GET('/v1/tenants/{id}', {
        params: { path: { id } },
      });
      return {
        tenant: await unwrap(Promise.resolve(result)),
        etag: etagOf(result),
      };
    },
    retry: false,
  });

/**
 * Renames, changes the slug, (de)activates. Each caller shows its own
 * refusals (a taken slug on its field, a 412 as a conflict). A rename shows
 * in the list, in the tenant switcher and in `/me`, so those are read again.
 */
export function useUpdateTenant(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (change: { body: TenantChanges; etag?: string }) =>
      unwrap(
        api.PATCH('/v1/tenants/{id}', {
          params: {
            path: { id },
            ...(change.etag && { header: { 'If-Match': change.etag } }),
          },
          body: change.body,
        }),
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
        queryClient.invalidateQueries({ queryKey: tenantsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
      ]),
  });
}

/**
 * Whether the signed-in user acts as one of the deployment's operators:
 * `GET /v1/auth/me` says so (`tenant.operator`), in a multi-tenant
 * deployment, for someone who may manage tenants. No request of its own.
 */
export function isOperator(
  me: ReturnType<typeof useMe>,
  tenancy: string | undefined,
): boolean {
  return (
    tenancy === 'multi' &&
    me?.tenant?.operator === true &&
    me.can['Access.manageTenants'] === true
  );
}

export function useOperator(): boolean {
  return isOperator(useMe(), useFeatures()?.tenancy);
}

/** Makes a tenant and invites its first administrator. */
export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: CreateTenantBody) =>
      unwrap(api.POST('/v1/tenants', { body })),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: tenantsAdminQuery.queryKey }),
  });
}

/** A handle from a name: lowercase words joined by dashes, 48 characters at most. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** The API's slug rule: lowercase letters and digits, single dashes between. */
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
