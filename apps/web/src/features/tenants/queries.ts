import {
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
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
 * refusals (a taken slug on its field, a 412 as a conflict). The ETag is
 * required: a write without `If-Match` would skip the concurrency check. A rename shows
 * in the list, in the tenant switcher and in `/me`, so those are read again.
 */
export function useUpdateTenant(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (change: { body: TenantChanges; etag: string }) =>
      unwrap(
        api.PATCH('/v1/tenants/{id}', {
          params: {
            path: { id },
            header: { 'If-Match': change.etag },
          },
          body: change.body,
        }),
      ),
    // Only a change that went through is read again: after a refusal (a 412
    // above all) the page keeps what it shows, and the user's input with it.
    onSuccess: () => invalidateTenants(queryClient),
  });
}

/** What a rename, a (de)activation or a deletion request changes on screen. */
const invalidateTenants = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['tenants'] }),
    queryClient.invalidateQueries({ queryKey: tenantsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
  ]);

/** One of the operator's break-glass grants to a tenant. */
export type BreakGlassGrant =
  GetResponse<'/v1/tenants/{id}/break-glass'>['items'][number];

/** The longest a grant lasts (the API's `minutes` ceiling, also its default). */
export const BREAK_GLASS_MAX_MINUTES = 60;

/** The operator's own grants to a tenant (`GET .../break-glass`), newest first. */
export const breakGlassQuery = (id: string) =>
  queryOptions({
    queryKey: ['tenants', 'break-glass', id],
    queryFn: () =>
      unwrap(
        api.GET('/v1/tenants/{id}/break-glass', { params: { path: { id } } }),
      ),
    retry: false,
  });

/** A grant that has neither ended nor run out. */
export const grantActive = (grant: BreakGlassGrant, now = Date.now()) =>
  !grant.endedAt && Date.parse(grant.expiresAt) > now;

/**
 * Opens a grant (`POST .../break-glass { reason, minutes }`). The step-up
 * (403 `reauthentication_required`) is asked and retried in lib/api.ts; the
 * caller shows the other refusals (409 `break_glass_active`, 403
 * `break_glass_disabled`...).
 */
export function useStartBreakGlass(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: { reason: string; minutes: number }) =>
      unwrap(
        api.POST('/v1/tenants/{id}/break-glass', {
          params: { path: { id } },
          body,
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: breakGlassQuery(id).queryKey }),
  });
}

/** Ends a grant before its time (`DELETE .../break-glass/{grantId}`). */
export function useEndBreakGlass(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (grantId: string) =>
      unwrap(
        api.DELETE('/v1/tenants/{id}/break-glass/{grantId}', {
          params: { path: { id, grantId } },
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: breakGlassQuery(id).queryKey }),
  });
}

/** The formats of a tenant's export (`POST /v1/tenants/{id}/export`). */
export const TENANT_EXPORT_FORMATS = ['json', 'csv', 'xlsx'] as const;
export type TenantExportFormat = (typeof TENANT_EXPORT_FORMATS)[number];

/**
 * Starts the export of every record of a tenant: 202 with the transfer's id,
 * followed with `TransferStatus`. The client sends the Idempotency-Key, and
 * the step-up (403 `reauthentication_required`) is asked and retried in
 * lib/api.ts.
 */
export function useExportTenant(id: string) {
  return useMutation({
    mutationFn: (format: TenantExportFormat) =>
      unwrap(
        api.POST('/v1/tenants/{id}/export', {
          params: { path: { id } },
          body: { format },
        }),
      ),
  });
}

/**
 * Asks for the tenant's deletion (`POST /v1/tenants/{id}/deletion { slug }`):
 * it is deactivated now and erased after the grace period. The caller shows
 * the refusals (a wrong slug on its field).
 */
export function useRequestTenantDeletion(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (slug: string) =>
      unwrap(
        api.POST('/v1/tenants/{id}/deletion', {
          params: { path: { id } },
          body: { slug },
        }),
      ),
    onSuccess: () => invalidateTenants(queryClient),
  });
}

/**
 * Keeps the tenant (`DELETE /v1/tenants/{id}/deletion`): 409
 * `tenant_deletion_started` once the erase has begun. Read again either way:
 * a 404 or a 409 means the page was out of date.
 */
export function useCancelTenantDeletion(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: () =>
      unwrap(
        api.DELETE('/v1/tenants/{id}/deletion', { params: { path: { id } } }),
      ),
    onSettled: () => invalidateTenants(queryClient),
  });
}

/** A deletion asked for and not begun yet: it can still be cancelled. */
export const deletionPending = (
  tenant: Pick<TenantRow, 'deletionScheduledFor' | 'deletionStartedAt'>,
) => Boolean(tenant.deletionScheduledFor) && !tenant.deletionStartedAt;

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
