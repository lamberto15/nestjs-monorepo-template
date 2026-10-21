import type { UserPrincipal } from './principal.js';

/**
 * Auth policies a tenant's administrators change at runtime
 * (docs/auth.md, "Policies"), with the deployment's environment as the
 * ceiling: what a tenant chooses may only tighten what the env allows,
 * never loosen it.
 *
 * IAM can't import the platform (core ← iam ← platform), where settings
 * live, so this is a port: the platform provides `AUTH_POLICY` (its
 * settings, `platform/auth-policy/`), and `AuthPolicyService` reads it
 * through the ceiling below. Without a provider (IAM alone, a project that
 * drops the platform), every policy is the environment's alone: today's
 * behaviour. The ceiling is applied here, in IAM, on what the source
 * returns, so a source can't loosen the environment even by mistake.
 */
export const AUTH_POLICY = Symbol('AUTH_POLICY');

/** What a tenant chose; `undefined`/`false`: nothing beyond the environment. */
export interface AuthPolicySource {
  /**
   * Whether the user's current tenant (`user.tenantId`) requires them to
   * have two-factor sign-in: the tenant's own choice, or one of the user's
   * teams'. Never per user: nobody exempts themselves.
   */
  requireMfa(user: UserPrincipal): Promise<boolean>;
  /** The tenant's minimum password length, if it chose one. */
  passwordMinLength(tenantId: string): Promise<number | undefined>;
  /** How many of an account's last passwords the tenant forbids reusing, if it chose. */
  passwordHistory(tenantId: string): Promise<number | undefined>;
  /**
   * Whether the tenant lets the deployment's operators open it with a
   * break-glass grant (docs/tenancy.md, "Break-glass"); false: it opted
   * out, and grants it has stop at once. Absent: allowed.
   */
  allowsBreakGlass?(tenantId: string): Promise<boolean>;
}

/** NIST SP 800-63B: the floor every password meets, whatever a tenant says. */
export const PASSWORD_MIN_LENGTH = 12;
/** The longest password accepted (`newPassword`, account.schemas.ts). */
export const PASSWORD_MAX_LENGTH = 128;
/** The highest minimum a tenant may ask for: a passphrase, still typeable. */
export const PASSWORD_MIN_LENGTH_LIMIT = 64;

/** The most passwords a tenant may forbid reusing (and so the history kept per account). */
export const PASSWORD_HISTORY_LIMIT = 24;

/** The part of the environment that caps the policies. */
export interface AuthPolicyCeiling {
  /** AUTH_MFA: off, nobody can enroll, so nobody can be required to. */
  AUTH_MFA: boolean;
}

/** Two-factor required: only when a tenant asks for it and the deployment allows enrolling. */
export const effectiveRequireMfa = (
  ceiling: AuthPolicyCeiling,
  chosen: boolean | undefined,
) => ceiling.AUTH_MFA && chosen === true;

/**
 * The minimum length for an account, from the choices of the tenants it
 * belongs to (a password is the account's, in every tenant): the
 * strictest, never under the floor nor over the limit.
 */
export const effectivePasswordMinLength = (
  chosen: readonly (number | undefined)[],
) =>
  Math.min(
    PASSWORD_MIN_LENGTH_LIMIT,
    Math.max(
      PASSWORD_MIN_LENGTH,
      ...chosen.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      ),
    ),
  );

/**
 * How many of the last passwords an account may not reuse (the current one
 * included): the strictest of the tenants it belongs to, 0 (off) when none
 * chose, never over the limit.
 */
export const effectivePasswordHistory = (
  chosen: readonly (number | undefined)[],
) =>
  Math.min(
    PASSWORD_HISTORY_LIMIT,
    Math.max(
      0,
      ...chosen.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      ),
    ),
  );

/**
 * Why a value can't be set in this deployment (the ceiling), or undefined.
 * The platform's settings ask it before storing an `auth.*` value.
 */
export function ceilingRefusal(
  ceiling: AuthPolicyCeiling,
  key: 'requireMfa',
  value: unknown,
): string | undefined {
  if (key === 'requireMfa' && value === true && !ceiling.AUTH_MFA) {
    return 'AUTH_MFA is off in this deployment: nobody can set up two-factor, so it can’t be required.';
  }
  return undefined;
}
