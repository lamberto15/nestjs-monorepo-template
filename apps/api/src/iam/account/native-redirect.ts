import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * A native app's redirect URI (NATIVE_REDIRECT_URIS): absolute, with no
 * fragment (the code goes in the query), and either an https universal /
 * app link (RFC 8252 §7.2) or a private-use scheme in reverse domain name
 * notation (§7.1: `com.example.app:`), never one a browser runs itself
 * (`javascript:`, `data:`, plain `http:`): an allowlist of shapes, not a
 * denylist of schemes.
 */
export function isNativeRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    !value.includes('#') &&
    (url.protocol === 'https:' ||
      /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:$/.test(url.protocol))
  );
}

/** RFC 7636: `S256`, the base64url SHA-256 of the verifier (43 characters). */
export const codeChallenge = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .describe(
    'PKCE (RFC 7636, S256): the base64url SHA-256 of a `codeVerifier` the app keeps for POST /auth/token/exchange.',
  );

/**
 * The login routes' native parameters (a provider's, a tenant's SSO): both,
 * or neither for a browser's login.
 */
export const nativeLoginQuery = {
  redirectUri: z
    .string()
    .max(2048)
    .optional()
    .describe(
      "A native app's: one of NATIVE_REDIRECT_URIS, where the sign-in ends with `?code=` (for POST /auth/token/exchange) or `?error=`, instead of a session in the browser. With `codeChallenge`.",
    ),
  codeChallenge: codeChallenge.optional(),
};

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
export const codeVerifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/** Whether `verifier` is the one `challenge` was made from (S256). */
export function verifiesChallenge(verifier: string, challenge: string) {
  const computed = Buffer.from(
    createHash('sha256').update(verifier).digest('base64url'),
  );
  const expected = Buffer.from(challenge);
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
}

/** `redirectUri` with `params` added to its query: where the system browser hands over to the app. */
export function nativeRedirect(
  redirectUri: string,
  params: Record<string, string>,
) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
