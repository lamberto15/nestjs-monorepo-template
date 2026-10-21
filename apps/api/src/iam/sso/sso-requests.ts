import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/drizzle.js';
import { SsoRefused } from './sso-accounts.service.js';
import { bindingHash, newBinding, SSO_REQUEST_TTL_MS } from './sso-browser.js';
import { ssoRequests } from './sso.tables.js';

/**
 * The authorization code flow's transactions (OpenID Connect and OAuth 2.0
 * connections), in `sso_requests`: bound to the browser that started them
 * (a cookie whose secret's SHA-256 is the `state`), one use each.
 */

/** A new sign-in under way: its row, and the browser's binding and `state`. */
export async function openCodeRequest(
  db: Database,
  connectionId: string,
  values: { codeVerifier: string; nonce?: string; redirectTo?: string },
) {
  const binding = newBinding();
  const state = bindingHash(binding);
  await db.delete(ssoRequests).where(lt(ssoRequests.expiresAt, new Date()));
  await db.insert(ssoRequests).values({
    connectionId,
    bindingHash: state,
    codeVerifier: values.codeVerifier,
    nonce: values.nonce ?? null,
    redirectTo: values.redirectTo ?? null,
    expiresAt: new Date(Date.now() + SSO_REQUEST_TTL_MS),
  });
  return { binding, state };
}

/**
 * The transaction this browser started (its cookie's binding, matching
 * `state`, unused, unexpired), taken once; else SsoRefused
 * (`state_mismatch`, `request_unknown`), then the IdP's own `error`.
 */
export async function takeCodeRequest(
  db: Database,
  connectionId: string,
  query: Record<string, string>,
  binding: string | undefined,
) {
  if (!binding || query.state !== bindingHash(binding)) {
    throw new SsoRefused('state_mismatch');
  }
  // One use: the first callback takes it, a replay finds nothing.
  const [request] = await db
    .update(ssoRequests)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(ssoRequests.connectionId, connectionId),
        eq(ssoRequests.bindingHash, query.state),
        isNull(ssoRequests.consumedAt),
        isNull(ssoRequests.samlRequestId),
        gt(ssoRequests.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!request?.codeVerifier) {
    throw new SsoRefused('request_unknown');
  }
  if (query.error) {
    throw new SsoRefused(`idp_error:${query.error.slice(0, 100)}`);
  }
  return { ...request, codeVerifier: request.codeVerifier };
}
