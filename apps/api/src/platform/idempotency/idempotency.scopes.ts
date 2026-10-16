import { tenantKey } from '../../core/tenancy/tenant-scope.js';
import {
  assertRequestPrincipal,
  principalKey,
  type Principal,
} from '../../iam/auth/principal.js';

/**
 * The key namespace: whoever is calling, an API client (by its key) or a
 * user (by their session), in the tenant they act in. The authentication
 * guard runs before the idempotency interceptor, so `request.user` is set;
 * two callers sending the same key never replay each other's responses,
 * and neither does one person in two tenants (`tenant:<id>:user:<id>`,
 * docs/tenancy.md): a replay in tenant B never returns what was done in
 * tenant A. A user acting in no tenant has an account scope of their own.
 */
export const principalScope = (req: { user?: Principal | null }) => {
  if (!req.user) {
    return undefined;
  }
  // PrincipalGuard refuses it before: a scope is never `system:…`.
  assertRequestPrincipal(req.user, 'An idempotency scope');
  const key = principalKey(req.user);
  return req.user.tenantId
    ? tenantKey(key, req.user.tenantId)
    : `account:${key}`;
};
