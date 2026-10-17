import { z } from 'zod';
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
  /** Off only for tests over plain HTTP; the cookie is then named "sid". */
  SESSION_COOKIE_SECURE: flag('on'),

  /**
   * Anyone may create an account (POST /auth/sign-up, and a first sign-in
   * with a provider). Off: accounts come from invitations only.
   */
  AUTH_SIGN_UP: flag('off'),
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
   * tests and load tests (refused in production: NODE_ENV).
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
  /** Encrypt TOTP secrets at rest: 32+ characters, newest first. Unset: created once. */
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
});

export type IamEnv = z.output<typeof iamEnv>;
