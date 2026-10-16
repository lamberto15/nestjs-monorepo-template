import {
  assertRequestPrincipal,
  principalKey,
  type Principal,
} from '../../iam/auth/principal.js';

/**
 * The key namespace: whoever is calling, an API client (by its key) or a
 * user (by their session). The authentication guard runs before the
 * idempotency interceptor, so `request.user` is set; two callers sending the
 * same key never replay each other's responses.
 */
export const principalScope = (req: { user?: Principal | null }) => {
  if (!req.user) {
    return undefined;
  }
  // PrincipalGuard refuses it before: a scope is never `system:…`.
  assertRequestPrincipal(req.user, 'An idempotency scope');
  return principalKey(req.user);
};
