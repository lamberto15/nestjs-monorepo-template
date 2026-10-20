import { createHash, randomBytes } from 'node:crypto';

/** How long a sign-in may take between the redirect to the IdP and its answer. */
export const SSO_REQUEST_TTL_MS = 10 * 60_000;
/** SAML: between the ACS (the IdP's POST) and the sign-in it hands over to. */
export const SSO_HANDOFF_TTL_MS = 2 * 60_000;

/** A new secret binding a sign-in to the browser that started it. */
export const newBinding = () => randomBytes(32).toString('base64url');

/** What the database keeps of a binding (and OIDC's `state`): its SHA-256. */
export const bindingHash = (binding: string) =>
  createHash('sha256').update(binding).digest('base64url');

/**
 * The cookie that binds an SSO sign-in to its browser: HttpOnly, the
 * `__Host-` prefix with Secure (SESSION_COOKIE_SECURE, off only for tests
 * over plain HTTP). `SameSite=None` when Secure: the SAML IdP answers with a
 * form POST from its own site, which a Lax cookie would not reach; the
 * cookie's secret is what proves the answer is for this browser, so it is
 * still worth nothing to another site (it can't read it). Without Secure,
 * browsers refuse `None`, so it is Lax there.
 */
export function ssoCookie(secure: boolean) {
  const name = secure ? '__Host-sso_tx' : 'sso_tx';
  const attributes = (maxAge: number) =>
    `Path=/; HttpOnly; Max-Age=${maxAge}; ${secure ? 'SameSite=None; Secure' : 'SameSite=Lax'}`;
  return {
    name,
    set: (binding: string, ttlMs = SSO_REQUEST_TTL_MS) =>
      `${name}=${binding}; ${attributes(Math.floor(ttlMs / 1000))}`,
    clear: () => `${name}=; ${attributes(0)}`,
    /** The binding the request's cookie holds, if any. */
    read(header: string | undefined) {
      for (const part of (header ?? '').split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) {
          const binding = value.join('=');
          return /^[A-Za-z0-9_-]{43}$/.test(binding) ? binding : undefined;
        }
      }
      return undefined;
    },
  };
}
