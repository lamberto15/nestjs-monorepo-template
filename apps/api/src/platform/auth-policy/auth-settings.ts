import { z } from 'zod';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_LENGTH_LIMIT,
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

/** IAM's auth policies as settings, added by the platform to the features'. */
export const AUTH_SETTINGS = defineSettings([
  AUTH_REQUIRE_MFA,
  AUTH_PASSWORD_MIN_LENGTH,
]);
