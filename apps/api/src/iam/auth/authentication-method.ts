import type { JwtClaims, SessionRecord } from '@nestjs/authentication';

/**
 * How a principal proved who they are. `sso` (a tenant's SAML or OIDC
 * connection, roadmap item 2) and `passkey` (WebAuthn, item 3) are named
 * here already: their sign-ins pass `sso:<connection>` or `passkey` as the
 * package's `method` and are recorded like the others. `impersonation`: a
 * session an administrator acts in (nobody signed in to it).
 */
export const SIGN_IN_METHODS = [
  'password',
  'magic-link',
  'oidc',
  'sso',
  'passkey',
  'impersonation',
] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/**
 * What a session's metadata (the package's `SessionRecord.metadata`, next to
 * `userAgent` and `ip`) records about its authentication. Flat keys: the
 * package merges a sign-in's `metadata` over `session.metadata(request)`
 * one level deep.
 */
export interface AuthenticationMetadata {
  /** How the session was created. */
  method?: SignInMethod;
  /** The OIDC provider (`google`) or the SSO connection. */
  provider?: string;
  /** When the user last proved who they are here: the sign-in, or a re-authentication (ISO 8601). */
  authenticatedAt?: string;
}

export const AUTHENTICATION_KEYS = [
  'method',
  'provider',
  'authenticatedAt',
] as const satisfies readonly (keyof AuthenticationMetadata)[];

/** The package's method string (`password`, `magic-link`, `oidc:google`, `sso:acme`) as metadata. */
export function methodMetadata(
  method: string,
): Pick<AuthenticationMetadata, 'method' | 'provider'> {
  const [name, ...rest] = method.split(':');
  const provider = rest.join(':');
  return {
    method: name as SignInMethod,
    ...(provider && { provider }),
  };
}

/** `SignInService.signIn()`'s options for a sign-in by `method`: the event's method, and the session's. */
export const signInOptions = (method: string) => ({
  method,
  metadata: methodMetadata(method),
});

/**
 * The claims of a token client's sign-in, fixed for its refresh family: how
 * (RFC 8176 `amr`; the package adds `mfa` itself), when (OpenID Connect
 * `auth_time`, epoch seconds), and the tenant the tokens act in (`tid`,
 * docs/tenancy.md; JwtAuth checks the membership on every request).
 */
export const tokenClaims = (
  amr: string[],
  at = new Date(),
  tenantId: string | null = null,
) => ({
  ...(amr.length > 0 && { amr }),
  auth_time: Math.floor(at.getTime() / 1000),
  ...(tenantId && { tid: tenantId }),
});

/** The metadata without its authentication keys, and those keys apart. */
export function splitAuthentication(
  metadata: Record<string, unknown> | undefined,
) {
  const rest: Record<string, unknown> = { ...metadata };
  const authentication: AuthenticationMetadata = {};
  for (const key of AUTHENTICATION_KEYS) {
    if (rest[key] !== undefined) {
      (authentication as Record<string, unknown>)[key] = rest[key];
    }
    delete rest[key];
  }
  return { rest, authentication };
}

/** How the credential of a request was authenticated: a cookie session or an access token. */
export interface CredentialAuthentication {
  via: 'session' | 'token';
  method: SignInMethod | null;
  provider: string | null;
  /** A second factor was verified. */
  mfa: boolean;
  /** When the user last proved who they are; null: unknown (counts as long ago). */
  authenticatedAt: Date | null;
}

const isSessionRecord = (session: unknown): session is SessionRecord =>
  typeof session === 'object' &&
  session !== null &&
  typeof (session as SessionRecord).userId === 'string' &&
  (session as SessionRecord).createdAt instanceof Date;

/** A valid date from an ISO string or epoch seconds, else null. */
function dateOf(value: unknown, unit: 'iso' | 'seconds') {
  const at =
    unit === 'iso'
      ? typeof value === 'string'
        ? Date.parse(value)
        : NaN
      : typeof value === 'number'
        ? value * 1000
        : NaN;
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * The authentication behind `request.session`: a session's metadata, or an
 * access token's `amr` (RFC 8176) and `auth_time` (OpenID Connect) claims.
 * `null` for anything else (an API key's session).
 */
export function authenticationOf(
  session: unknown,
): CredentialAuthentication | null {
  if (isSessionRecord(session)) {
    const metadata = (session.metadata ?? {}) as AuthenticationMetadata;
    return {
      via: 'session',
      method: SIGN_IN_METHODS.includes(metadata.method!)
        ? metadata.method!
        : null,
      provider: metadata.provider ?? null,
      mfa: session.mfa === 'verified',
      authenticatedAt: dateOf(metadata.authenticatedAt, 'iso'),
    };
  }
  if (
    typeof session === 'object' &&
    session !== null &&
    typeof (session as JwtClaims).sub === 'string'
  ) {
    const claims = session as JwtClaims;
    const amr = Array.isArray(claims.amr) ? (claims.amr as unknown[]) : [];
    return {
      via: 'token',
      method: amr.includes('pwd') ? 'password' : null,
      provider: null,
      mfa: amr.includes('mfa'),
      authenticatedAt: dateOf(claims.auth_time, 'seconds'),
    };
  }
  return null;
}

/**
 * Whether the authentication counts as recent at `now`: made before
 * `recentUntil`, and not in the future (another instance's clock: a
 * minute's leeway). Never for an impersonation, whatever its session says:
 * nobody signed in to it.
 */
export function isRecent(
  authentication: CredentialAuthentication | null,
  recentUntil: Date | null,
  now = Date.now(),
) {
  if (!authentication || authentication.method === 'impersonation') {
    return false;
  }
  const at = authentication.authenticatedAt?.getTime();
  return (
    at !== undefined &&
    recentUntil !== null &&
    now < recentUntil.getTime() &&
    at <= now + 60_000
  );
}
