import { z } from 'zod';
import {
  PASSWORD_HISTORY_LIMIT,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_LENGTH_LIMIT,
  SESSION_IDLE_MINUTES_FLOOR,
  SESSION_IDLE_MINUTES_LIMIT,
  SESSION_MAX_HOURS_LIMIT,
} from '../../iam/auth/auth-policy.js';
import { defineSettings, setting } from '../settings/setting.types.js';

/**
 * Two-factor sign-in required (docs/auth.md, "Policies"): for the whole
 * tenant, or for a team's members. Never per user: nobody exempts
 * themselves. `true` on any scope that applies wins (a team's `false`
 * doesn't exempt its members from the tenant's `true`). Not a flag: no
 * rollout. AUTH_MFA=off: refused (setting_not_allowed), and a value stored
 * before has no effect.
 */
export const AUTH_REQUIRE_MFA = setting({
  key: 'auth.requireMfa',
  label: 'Require two-factor sign-in',
  description:
    'Users without an authenticator app may only set one up after signing in; API clients are unaffected.',
  schema: z.boolean(),
  default: false,
  scopes: ['tenant', 'team'],
  public: false,
});

/**
 * The minimum length of a new password for the tenant's members, above
 * the floor (12) every deployment keeps. A person in several tenants
 * meets the strictest.
 */
export const AUTH_PASSWORD_MIN_LENGTH = setting({
  key: 'auth.passwordMinLength',
  label: 'Minimum password length',
  description: `Characters a new password needs (${PASSWORD_MIN_LENGTH} to ${PASSWORD_MIN_LENGTH_LIMIT}): set, changed, reset, or chosen when accepting an invitation.`,
  schema: z
    .number()
    .int()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MIN_LENGTH_LIMIT),
  default: PASSWORD_MIN_LENGTH,
  public: false,
});

/**
 * How many of an account's last passwords a new one may not repeat (the
 * current one counts): 0, the default, is off. Only hashes are kept, and
 * only while it is on. A person in several tenants meets the strictest.
 */
export const AUTH_PASSWORD_HISTORY = setting({
  key: 'auth.passwordHistory',
  label: 'Password history',
  description: `How many of an account's last passwords can't be used again (0 to ${PASSWORD_HISTORY_LIMIT}, 0 is off): a change or a reset with one of them is refused.`,
  schema: z.number().int().min(0).max(PASSWORD_HISTORY_LIMIT),
  default: 0,
  public: false,
});

/**
 * Whether the deployment's operators may open this tenant with a
 * break-glass grant (docs/tenancy.md, "Break-glass"): read only, an hour
 * at most, a reason its administrators are told. `false` opts the tenant
 * out (an enterprise customer's contract): new grants are refused (403
 * `break_glass_disabled`) and running ones stop on their next request.
 * The tenant's own choice only: no team or user scope.
 */
export const AUTH_ALLOW_BREAK_GLASS = setting({
  key: 'auth.allowBreakGlass',
  label: 'Allow break-glass access by the operators',
  description:
    "Off: the deployment's operators can never read this tenant without an invitation, not even in an emergency.",
  schema: z.boolean(),
  default: true,
  public: false,
});

/**
 * How long a tenant's sessions may sit idle before they end, in minutes.
 * Under the deployment's ceiling (SESSION_IDLE_MINUTES): a longer value is
 * refused (setting_not_allowed). The tenant's own choice only.
 */
export const AUTH_SESSION_IDLE_MINUTES = setting({
  key: 'auth.sessionIdleMinutes',
  label: 'Session idle timeout',
  description: `Minutes without a request after which a session ends (${SESSION_IDLE_MINUTES_FLOOR} or more, at most the deployment's SESSION_IDLE_MINUTES). The default is the largest allowed, so the deployment's applies.`,
  schema: z
    .number()
    .int()
    .min(SESSION_IDLE_MINUTES_FLOOR)
    .max(SESSION_IDLE_MINUTES_LIMIT),
  default: SESSION_IDLE_MINUTES_LIMIT,
  public: false,
});

/**
 * The longest a tenant's session lasts from its sign-in, in hours, however
 * active; token clients' refresh-token families end then too. Under the
 * deployment's ceiling (SESSION_MAX_HOURS).
 */
export const AUTH_SESSION_MAX_HOURS = setting({
  key: 'auth.sessionMaxHours',
  label: 'Session maximum lifetime',
  description:
    "Hours after sign-in when a session, or a token client's refresh-token family, ends however active (at most the deployment's SESSION_MAX_HOURS). The default is the largest allowed, so the deployment's applies.",
  schema: z.number().int().min(1).max(SESSION_MAX_HOURS_LIMIT),
  default: SESSION_MAX_HOURS_LIMIT,
  public: false,
});

/** IAM's auth policies as settings, added by the platform to the features'. */
export const AUTH_SETTINGS = defineSettings([
  AUTH_REQUIRE_MFA,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PASSWORD_HISTORY,
  AUTH_ALLOW_BREAK_GLASS,
  AUTH_SESSION_IDLE_MINUTES,
  AUTH_SESSION_MAX_HOURS,
]);
