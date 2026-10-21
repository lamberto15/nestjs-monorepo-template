import { z } from 'zod';
import {
  SESSION_IDLE_MINUTES_FLOOR,
  SESSION_IDLE_MINUTES_LIMIT,
  SESSION_MAX_HOURS_LIMIT,
} from './auth/auth-policy.js';
import { TURNSTILE_VERIFY_URL } from './captcha/captcha.providers.js';
import {
  baseUrl,
  flag,
  list,
  optional,
  secret,
  withDefault,
} from '../core/config/env.helpers.js';

/** The environment of identity and access: sign-in, accounts, MFA, OAuth. */
export const iamEnv = z.object({
  /** The first administrator, created when there's no users yet. */
  ADMIN_EMAIL: withDefault('admin@example.com'),
  /** Unset: a password is generated and logged once. */
  ADMIN_PASSWORD: secret(optional()),
  /**
   * The first tenant, made with the first administrator: the deployment's
   * operator tenant (docs/tenancy.md). Its handle (`slug`) comes from the name.
   */
  ADMIN_TENANT_NAME: withDefault('Default'),
  /**
   * `multi`: operators make more tenants (POST /v1/tenants), and people join
   * one by invitation. `single`: the first tenant is the only one (making
   * another is refused), and a self sign-up (AUTH_SIGN_UP) joins it
   * (docs/tenancy.md, "Single-tenant deployments").
   */
  TENANCY: z.enum(['multi', 'single']).default('multi'),
  /**
   * TENANCY=single: the roles a self sign-up gets in the tenant (seed role
   * keys, comma-separated: `editor,viewer`; never `administrator`). Unset:
   * none, until an administrator grants some.
   */
  SIGN_UP_ROLES: list(),
  /** Off only for tests over plain HTTP; the cookie is then named "sid". */
  SESSION_COOKIE_SECURE: flag('on'),
  /**
   * A browser session ends after this many minutes without a request. The
   * deployment's ceiling: a tenant's `auth.sessionIdleMinutes` may only
   * shorten it (docs/auth.md, "Policies"). At least 5, so the web app can
   * warn before it ends.
   */
  SESSION_IDLE_MINUTES: z.coerce
    .number()
    .int()
    .min(SESSION_IDLE_MINUTES_FLOOR)
    .max(SESSION_IDLE_MINUTES_LIMIT)
    .default(120),
  /**
   * A browser session ends this many hours after its sign-in, however
   * active. The deployment's ceiling: a tenant's `auth.sessionMaxHours` may
   * only shorten it, and it shortens token clients' refresh-token families
   * too (which otherwise last 90 days).
   */
  SESSION_MAX_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(SESSION_MAX_HOURS_LIMIT)
    .default(12),

  /**
   * Anyone may create an account (POST /auth/sign-up, and a first sign-in
   * with a provider). Off: accounts come from invitations only.
   */
  AUTH_SIGN_UP: flag('off'),
  /**
   * TENANCY=multi with AUTH_SIGN_UP=on: a self sign-up makes its own tenant,
   * the new account its first administrator (docs/tenancy.md, "Tenants made
   * at sign-up"). Off: sign-ups join no tenant, operators make tenants
   * (POST /v1/tenants). Ignored, with a warning, with TENANCY=single.
   */
  TENANT_SIGN_UP: flag('off'),
  /**
   * Refuse a new password found in data breaches (Have I Been Pwned's
   * Pwned Passwords, by k-anonymity: only 5 characters of its SHA-1 leave
   * the process). Sign-up, reset and invitation links, change, an
   * administrator's create and update; ADMIN_PASSWORD is only warned about.
   */
  PASSWORD_BREACH_CHECK: flag('on'),
  /** The range API's base URL: a self-hosted mirror for air-gapped deployments. */
  PASSWORD_BREACH_API_URL: baseUrl('https://api.pwnedpasswords.com'),
  /** How long a check may take (one attempt: the user waits on it). */
  PASSWORD_BREACH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(2000),
  /**
   * When the API can't be reached (timeout, error): `allow` the password
   * unchecked, with a warning in the logs (fail-open), or `reject` it with a
   * 503 `password_check_unavailable` (fail-closed).
   */
  PASSWORD_BREACH_ON_ERROR: z.enum(['allow', 'reject']).default('allow'),
  /** Refused when seen in at least this many breaches. */
  PASSWORD_BREACH_MIN_COUNT: z.coerce.number().int().min(1).default(1),
  /**
   * A sign-in's password is checked too, after the sign-in and without
   * delaying it (SignInPasswordCheck): once per password, then again after
   * this many days (the corpus grows), until the password changes.
   */
  PASSWORD_BREACH_RECHECK_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30),
  /**
   * Password hashes (scrypt, 128 MiB each outside the heap) running at once
   * in this process; the container's memory limit must hold the heap plus
   * this many: docs/deployment.md, "Resource limits".
   */
  PASSWORD_HASH_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** Hashes waiting for a slot; beyond that, 503 `server_busy` at once. */
  PASSWORD_HASH_MAX_QUEUE: z.coerce.number().int().min(0).default(20),
  /** How long a hash waits for a slot, then 503 `server_busy` (Retry-After). */
  PASSWORD_HASH_QUEUE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5000),
  /** Passwordless sign-in by email link (POST /auth/magic-link). */
  AUTH_MAGIC_LINK: flag('on'),

  // Passkeys (WebAuthn; docs/auth.md, "Passkeys"). The relying party is
  // the web app's host: the RP ID never changes once passkeys exist (every
  // credential is bound to it), so it is configuration, not a guess.
  /** Passkeys: registering them, signing in with them (POST /auth/passkeys/…). */
  PASSKEYS: flag('on'),
  /**
   * The relying party id: a registrable domain the web app is served on
   * (`example.com` covers `app.example.com` too), never a port or a scheme.
   * Unset: WEB_URL's host (else APP_URL's). Production refuses `localhost`
   * and IP addresses, and an RP ID that the origins below don't belong to.
   */
  PASSKEY_RP_ID: optional().refine(
    (value) => value === undefined || /^[a-z0-9.-]+$/i.test(value),
    'a host name without scheme, port or path',
  ),
  /** The name authenticators show for this service; default SERVICE_NAME. */
  PASSKEY_RP_NAME: optional(),
  /**
   * Origins ceremonies may run on, besides WEB_URL's (comma-separated
   * `https://…` URLs, or `android:apk-key-hash:…` for an Android app that
   * isn't listed in PASSKEY_ANDROID_APPS). Each https origin's host must be
   * the RP ID or under it.
   */
  PASSKEY_ORIGINS: list(),
  /** How long a ceremony's challenge lives (one-time, in Redis), and the browser's timeout. */
  PASSKEY_CHALLENGE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(600)
    .default(120),
  /**
   * Android apps allowed to use the passkeys of this RP ID (served at
   * /.well-known/assetlinks.json): `package.name:SHA256:FINGERPRINT` of the
   * signing certificate (comma-separated apps; the fingerprint as
   * `keytool` or the Play Console prints it, colon-separated hex). Each
   * one's `android:apk-key-hash:` origin is derived from the fingerprint.
   */
  PASSKEY_ANDROID_APPS: list().refine(
    (apps) =>
      apps.every((app) =>
        /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+:([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(
          app,
        ),
      ),
    'comma-separated `package.name:AA:BB:…` (a SHA-256 certificate fingerprint, 32 colon-separated hex pairs)',
  ),
  /**
   * iOS and macOS apps allowed to use the passkeys of this RP ID (served at
   * /.well-known/apple-app-site-association): `TEAMID.bundle.identifier`,
   * comma-separated.
   */
  PASSKEY_APPLE_APPS: list().refine(
    (apps) => apps.every((app) => /^[A-Z0-9]{10}\.[a-z0-9.-]+$/i.test(app)),
    'comma-separated `TEAMID.bundle.identifier`',
  ),

  // Bot protection on the public account routes (docs/auth.md, "Bot protection").
  /**
   * When a challenge token (`X-Captcha-Token`) is required on sign-in,
   * sign-up, the magic-link request and forgot password: `always`,
   * `after-failures` (once an address or an account had CAPTCHA_FAILURES
   * failed attempts in CAPTCHA_FAILURES_WINDOW_MINUTES), or `off`.
   */
  CAPTCHA_MODE: z.enum(['off', 'always', 'after-failures']).default('off'),
  /**
   * Who verifies the tokens: Cloudflare `turnstile`, or the `stub` of the
   * tests and load tests (refused in production: NODE_ENV, except APP_ENV=loadtest).
   */
  CAPTCHA_PROVIDER: z.enum(['turnstile', 'stub']).default('turnstile'),
  /** Turnstile's site key (public: the widget's, shown by GET /auth/methods). Required with the mode on. */
  TURNSTILE_SITE_KEY: optional(),
  /** Turnstile's secret key, for the server-side verification. Required with the mode on. */
  TURNSTILE_SECRET_KEY: secret(optional()),
  /** The siteverify endpoint: Cloudflare's, or a stand-in in tests. */
  CAPTCHA_VERIFY_URL: baseUrl(TURNSTILE_VERIFY_URL),
  /**
   * The host names the widget may run on, as the provider reports them
   * (comma-separated, no port). Unset: WEB_URL's host.
   */
  CAPTCHA_HOSTNAMES: list(),
  /** How long a verification may take (one attempt: the user waits on it). */
  CAPTCHA_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(2000),
  /**
   * When the provider can't be reached (timeout, error, circuit open):
   * `allow` the request under a stricter limit (CAPTCHA_DEGRADED_LIMIT per
   * address in the window: fail-open), or `reject` it with a 503
   * `captcha_unavailable` (fail-closed).
   */
  CAPTCHA_ON_ERROR: z.enum(['allow', 'reject']).default('allow'),
  /** `after-failures`: failed attempts per address (and per email and address) before a token is required. */
  CAPTCHA_FAILURES: z.coerce.number().int().min(1).max(100).default(3),
  /** The window of CAPTCHA_FAILURES, and of CAPTCHA_DEGRADED_LIMIT. */
  CAPTCHA_FAILURES_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(15),
  /** Fail-open: requests let through unverified per address (and per email and address) in the window. */
  CAPTCHA_DEGRADED_LIMIT: z.coerce.number().int().min(1).max(100).default(2),
  /** Signs access tokens for mobile apps and CLIs (HS256, 32+ bytes). Unset: created once. */
  JWT_SECRET: secret(optional()),
  /** Encrypt TOTP secrets at rest: 32+ characters, newest first. Required in production (never created in the database there; an existing app_secrets row still works, with a warning); created once elsewhere. */
  MFA_ENCRYPTION_KEYS: secret(optional()),
  /** The name authenticator apps show; default SERVICE_NAME. */
  MFA_ISSUER: optional(),
  /** How long a tenant's invitation link works (docs/tenancy.md, "Invitations"). */
  INVITATION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(30 * 24)
    .default(7 * 24),
  /**
   * How many days an operator has to cancel a tenant's deletion
   * (POST /v1/tenants/{id}/deletion) before TenantDeletionJob erases it
   * (docs/tenancy.md, "Deleting a tenant"). The tenant is deactivated
   * meanwhile.
   */
  TENANT_DELETION_GRACE_DAYS: z.coerce.number().int().min(0).default(30),
  /**
   * Support impersonation (an administrator acts as a user:
   * POST /access/users/{id}/impersonate). Off: those routes answer 404
   * `feature_off`, and a running impersonation ends at its next request.
   * A privileged tool: opt in.
   */
  IMPERSONATION: flag('off'),
  /**
   * Two-factor sign-in (TOTP). Off: nobody can set it up (POST
   * /auth/mfa/enroll and /confirm answer 404 `feature_off`), but accounts
   * that already have it keep being asked for a code, and can still use or
   * turn off their own: switching it off never weakens an account silently.
   */
  AUTH_MFA: flag('on'),
  /**
   * API clients (machine keys `sk_...`). Off: their management routes answer
   * 404 `feature_off`, and a bearer key no longer authenticates (401);
   * users are unaffected. Clients and keys stay stored, working again when on.
   */
  API_CLIENTS: flag('on'),
  /** How long an administrator may act as another user. */
  IMPERSONATION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(480)
    .default(60),
  /**
   * How long a sign-in or a re-authentication (POST /auth/reauthenticate)
   * counts as recent for the sensitive routes (`@RecentAuthentication()`):
   * older, they answer 403 `reauthentication_required`.
   */
  REAUTHENTICATION_MAX_AGE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(10),
  /** Audit entries older than this many days are deleted every night. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(400),
  /** How long a deleted record stays in its recycle bin (soft delete) before the purge. */
  SOFT_DELETE_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),

  // Sign in with a provider: each one is on when its client id and secret are set.
  // Redirect URI to register: <APP_URL>/v1/auth/oidc/<provider>/callback
  GOOGLE_CLIENT_ID: optional(),
  GOOGLE_CLIENT_SECRET: secret(optional()),
  /** Microsoft Entra ID: the tenant's id (a GUID), single tenant. */
  MICROSOFT_TENANT_ID: optional(),
  MICROSOFT_CLIENT_ID: optional(),
  MICROSOFT_CLIENT_SECRET: secret(optional()),
  GITHUB_CLIENT_ID: optional(),
  GITHUB_CLIENT_SECRET: secret(optional()),

  /**
   * Development and tests only: a tenant's OpenID Connect issuer (and its
   * endpoints) may be `http://` on loopback or a private network, as a
   * local identity provider is. Off: only public `https://` hosts
   * (docs/auth.md, "Enterprise SSO").
   */
  SSO_ALLOW_LOOPBACK: flag('off'),
});

export type IamEnv = z.output<typeof iamEnv>;
