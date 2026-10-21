import { ForbiddenException } from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { z } from 'zod';
import { isTimeZone } from '../../core/config/env.helpers.js';
import { redirectPath } from '../../core/http/redirect-path.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';

/** Passwords: 12 to 128 characters (NIST 800-63B: length over composition rules). */
export const newPassword = z.string().min(12).max(128);
/** An email address; spaces around it (a paste) are dropped first. */
export const email = z
  .string()
  .trim()
  .pipe(z.email())
  .meta({ example: 'ada@example.com' });
export const token = z.string().min(1).max(512);
export const timezone = z
  .string()
  .max(64)
  .refine(isTimeZone, 'must be an IANA time zone, e.g. Europe/Berlin')
  .meta({ example: 'Europe/Berlin' });
/** A BCP 47 language tag; the route checks it against LOCALES. */
export const locale = z.string().min(2).max(35).meta({ example: 'de' });
/** Where to send the browser after a sign-in by link or provider: a path of the web app (`isSafeRedirectPath`). */
export const redirectTo = redirectPath.optional();

export const userSchema = z.object({
  kind: z.literal('user'),
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  avatarUrl: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Their picture (PUT /v1/account/avatar): a path on this API to put in an `<img>` (sign-in required, the same session or token); null: none. A new picture is a new address.',
    ),
  tenantId: z
    .string()
    .nullable()
    .describe(
      'The tenant this session or token acts in (GET /auth/tenants, POST /auth/tenant); null: none (no membership yet).',
    ),
  impersonator: z
    .object({ id: z.string(), email: z.string() })
    .optional()
    .describe('Set while an administrator acts as this user.'),
});

export const signedInSchema = z.object({
  signedIn: z.boolean(),
  mfaRequired: z
    .boolean()
    .describe(
      'true: send a code to POST /auth/mfa/verify to finish signing in.',
    ),
  redirectTo: z.string().optional(),
});

export const acceptedSchema = z.object({ accepted: z.literal(true) });

/** Credentials can't be changed by an administrator acting as the user. */
/**
 * Refuses a way in (a second factor, a linked provider) for an account
 * whose owner never proved the address (403 `email_unverified`): whoever
 * holds such an account's session may not be its owner, and must not
 * bind their own authenticator or provider to it (docs/tenancy.md).
 */
export function verifiedEmailOnly(user: UserPrincipal) {
  if (!user.emailVerified) {
    throw new ForbiddenException({
      code: 'email_unverified',
      message: t('auth.emailUnverified'),
    });
  }
}

export function notWhileImpersonating(user: Principal) {
  if (user.kind === 'user' && user.impersonator) {
    throw new ForbiddenException(t('auth.notWhileImpersonating'));
  }
}

export type User = UserPrincipal;
