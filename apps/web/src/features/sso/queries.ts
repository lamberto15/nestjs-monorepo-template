import {
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  unwrap,
  type GetResponse,
  type paths,
} from '@nestjs-monorepo-template/api-client';
import { api } from '@/lib/api';

export type Connection = GetResponse<'/v1/sso/connections'>['items'][number];
export type Policy = GetResponse<'/v1/sso/policy'>;
export type Domain = GetResponse<'/v1/sso/domains'>['items'][number];

type JsonBody<T> = T extends {
  requestBody: { content: { 'application/json': infer B } };
}
  ? B
  : never;

/** What a create sends: an OIDC or a SAML connection (by `protocol`). */
export type CreateConnectionBody = JsonBody<
  paths['/v1/sso/connections']['post']
>;
/** What a PATCH changes: only what is sent. */
export type ConnectionChanges = JsonBody<
  paths['/v1/sso/connections/{id}']['patch']
>;

/** Every SSO query starts with this key (one invalidation covers all). */
export const ssoKey = ['sso'] as const;

export const connectionsQuery = queryOptions({
  queryKey: [...ssoKey, 'connections'],
  queryFn: () => unwrap(api.GET('/v1/sso/connections')),
});

export const policyQuery = queryOptions({
  queryKey: [...ssoKey, 'policy'],
  queryFn: () => unwrap(api.GET('/v1/sso/policy')),
});

export const domainsQuery = queryOptions({
  queryKey: [...ssoKey, 'domains'],
  queryFn: () => unwrap(api.GET('/v1/sso/domains')),
});

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ssoKey });
}

// The dialogs show the refusals (field errors): the global handler stays
// quiet for the writes that have a form. Creating, changing and removing a
// connection need a recent sign-in: a 403 `reauthentication_required` is
// answered by the re-authenticate dialog and retried (lib/api.ts).
export function useCreateConnection() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (body: CreateConnectionBody) =>
      unwrap(api.POST('/v1/sso/connections', { body })),
    onSuccess: refresh,
  });
}

/** Reads a SAML IdP's metadata (nothing is stored): the fields a connection takes. */
export function useImportSamlMetadata() {
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (url: string) =>
      unwrap(api.POST('/v1/sso/saml/metadata', { body: { url } })),
  });
}

export function useUpdateConnection() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { id: string; changes: ConnectionChanges }) =>
      unwrap(
        api.PATCH('/v1/sso/connections/{id}', {
          params: { path: { id: input.id } },
          body: input.changes,
        }),
      ),
    onSuccess: refresh,
  });
}

export function useRemoveConnection() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE('/v1/sso/connections/{id}', { params: { path: { id } } }),
      ),
    onSuccess: refresh,
  });
}

/** Fetches an OIDC connection's discovery document again (202, on the queue). */
export function useRefreshConnection() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/v1/sso/connections/{id}/refresh', {
          params: { path: { id } },
        }),
      ),
    onSuccess: refresh,
  });
}

export function useCreateDomain() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (domain: string) =>
      unwrap(api.POST('/v1/sso/domains', { body: { domain } })),
    onSuccess: refresh,
  });
}

/** Looks the TXT record up on the queue; the list shows the outcome. */
export function useVerifyDomain() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/v1/sso/domains/{id}/verify', { params: { path: { id } } }),
      ),
    onSuccess: refresh,
  });
}

export function useRemoveDomain() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/v1/sso/domains/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });
}

/**
 * Require SSO (or stop). A refusal (409 `sso_lockout`,
 * `sso_connection_required`) is toasted by the caller; it needs a recent sign-in (re-authenticate dialog, lib/api.ts).
 */
export function useSetPolicy() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (requireSso: boolean) =>
      unwrap(api.PUT('/v1/sso/policy', { body: { requireSso } })),
    onSuccess: refresh,
  });
}

export function useRemoveExemption() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (userId: string) =>
      unwrap(
        api.DELETE('/v1/sso/exemptions/{userId}', {
          params: { path: { userId } },
        }),
      ),
    onSuccess: refresh,
  });
}

/**
 * Exempt a member from "SSO required" (break-glass). A refusal (404 not an
 * active member, 409 `sso_exemption_needs_mfa`) shows in the dialog.
 */
export function useAddExemption() {
  const refresh = useRefresh();
  return useMutation({
    meta: { errorToast: false },
    mutationFn: (input: { userId: string; reason: string }) =>
      unwrap(
        api.PUT('/v1/sso/exemptions/{userId}', {
          params: { path: { userId: input.userId } },
          body: { reason: input.reason },
        }),
      ),
    onSuccess: refresh,
  });
}
