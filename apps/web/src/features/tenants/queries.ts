import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';
import { useFeatures, useMe } from '@/lib/features';

export type TenantRow = GetResponse<'/v1/tenants'>['items'][number];

/** What a create sends: the tenant's name and slug, and its first administrator. */
export type CreateTenantBody = paths['/v1/tenants']['post'] extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/**
 * Every tenant (`GET /v1/tenants`). Only the operators may ask: anyone else
 * gets 403 `operator_required`, which is how the app tells them apart
 * (`GET /v1/auth/me` does not say), so a failure is the caller's to read,
 * never a toast.
 */
export const tenantsAdminQuery = queryOptions({
  queryKey: ['tenants', 'list'],
  queryFn: () => unwrap(api.GET('/v1/tenants')),
  retry: false,
  meta: { errorToast: false },
});

/**
 * Whether the user is one of the deployment's operators: the list answers
 * (no 403) in a multi-tenant deployment, for someone who may manage tenants.
 * False until known; asks only whoever could be one.
 */
export function useOperator(): boolean {
  const multi = useFeatures()?.tenancy === 'multi';
  const may = useMe()?.can['Access.manageTenants'] === true;
  const list = useQuery({ ...tenantsAdminQuery, enabled: multi && may });
  return multi && may && list.isSuccess;
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
