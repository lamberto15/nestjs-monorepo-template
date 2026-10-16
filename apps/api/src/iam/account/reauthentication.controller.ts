import { Body, Controller, Get, HttpCode, Ip, Post, Res } from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { UserThrottle } from '../auth/user-throttle.guard.js';
import { ReauthenticationService } from './reauthentication.service.js';

const proofSchema = z.object({
  password: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Required when the account has a password.'),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('With two-factor on: a code from the app (or a recoveryCode).'),
  recoveryCode: z.string().min(1).max(64).optional(),
  refreshToken: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'A token client: your current refresh token, revoked (its whole family) once the new tokens are issued. Unknown: ignored.',
    ),
});

const methodsSchema = z.object({
  methods: z
    .array(z.string())
    .describe(
      'How you can re-authenticate. In place, with POST /auth/reauthenticate: `password`; `totp` (a code alone, for an account without a password). By signing in again, which counts as well: `magic-link` (POST /auth/magic-link), `oidc:<provider>` (GET /auth/oidc/{provider}/login?reauthenticate=true: the provider is asked to authenticate you again).',
    ),
  mfaRequired: z
    .boolean()
    .describe('In place, a code (or a recoveryCode) goes with the password.'),
});

const statusSchema = methodsSchema.extend({
  authenticatedAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When you last signed in or re-authenticated here; null: unknown.',
    ),
  recentUntil: z.iso
    .datetime()
    .nullable()
    .describe(
      'Until when the sensitive routes accept it (REAUTHENTICATION_MAX_AGE_MINUTES, the default window: a route may ask for a shorter one); past, or null (unknown, or acting as another user), they want a re-authentication.',
    ),
  maxAge: z.number().int().describe('The default window, in seconds.'),
});

const reauthenticatedSchema = z.object({
  authenticatedAt: z.iso.datetime(),
  recentUntil: z.iso.datetime(),
  tokens: z
    .object({
      accessToken: z.string(),
      refreshToken: z.string(),
      expiresIn: z.number().int(),
    })
    .optional()
    .describe(
      "A token client's new tokens: use them from now on. The old family keeps its time; it was revoked when the request sent its refreshToken, else revoke it (POST /auth/token/revoke).",
    ),
});

/**
 * Step-up: the sensitive routes (`@RecentAuthentication()`: a new password,
 * two-factor off, an API key, deleting the account, …) want a sign-in from
 * the last REAUTHENTICATION_MAX_AGE_MINUTES. Older, they answer 403
 * `reauthentication_required`; the user proves who they are again here,
 * or signs in again by link or provider, and retries.
 */
@ApiTags('auth')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Can.Anyone()
@Controller('auth/reauthenticate')
export class ReauthenticationController {
  constructor(private readonly reauthentication: ReauthenticationService) {}

  @Get()
  @ApiOperation({
    summary: 'When you last authenticated, and how to do it again',
  })
  @ApiOkResponse({ standardSchema: statusSchema })
  async status(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
  ) {
    const { authentication, recentUntil } =
      this.reauthentication.status(session);
    return {
      authenticatedAt: authentication?.authenticatedAt?.toISOString() ?? null,
      recentUntil:
        user.impersonator || !recentUntil ? null : recentUntil.toISOString(),
      maxAge: this.reauthentication.maxAgeMs() / 1000,
      ...(await this.reauthentication.options(user)),
    };
  }

  // Five tries from an address every 15 minutes, as signing in, and ten for
  // the account from anywhere (the body names no email for the global guard
  // to count by); a wrong code counts towards the lockout.
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @UserThrottle({ limit: 10, ttl: minutes(15) })
  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Prove again who you are, for the sensitive routes',
    description:
      'Your password, with a code when two-factor is on (a code alone when the account has no password). A session gets a new id (the cookie changes: a request sent meanwhile with the old one gets 401; reconnect realtime); a token client gets new tokens, and the family of the refreshToken it sent is revoked. Audited. Never while acting as another user.',
  })
  @ApiOkResponse({ standardSchema: reauthenticatedSchema })
  @ApiBadRequestResponse({
    description: 'The password or the code is missing (validation_failed).',
  })
  @ApiForbiddenResponse({
    description:
      '`reauthentication_failed`: a wrong password or code; or acting as another user.',
  })
  @ApiConflictResponse({
    description:
      '`reauthentication_unavailable`: no password and no two-factor: sign in again with one of `methods`.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'More than 5 attempts from this address, or 10 for this account, in 15 minutes.',
  })
  async reauthenticate(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Body({ schema: proofSchema }) body: z.infer<typeof proofSchema>,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const done = await this.reauthentication.reauthenticate(
      user,
      session,
      body,
      ip,
    );
    if (done.cookie) {
      res.append('Set-Cookie', done.cookie);
    }
    return {
      authenticatedAt: done.authenticatedAt.toISOString(),
      recentUntil: done.recentUntil.toISOString(),
      ...(done.tokens && { tokens: done.tokens }),
    };
  }
}
