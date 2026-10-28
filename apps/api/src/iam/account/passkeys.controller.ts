import { DuringOnboarding } from '../auth/onboarding.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  Public,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { NodeResponse as Response } from '@nestjs/platform-node';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { listSchema } from '../../core/http/pagination.js';
import { authenticationOf } from '../auth/authentication-method.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { AddressThrottle } from '../auth/address-throttle.guard.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { UserThrottle } from '../auth/user-throttle.guard.js';
import { Captcha } from '../captcha/captcha.guard.js';
import {
  email,
  notWhileImpersonating,
  signedInSchema,
} from './account.schemas.js';
import {
  authenticationResponseSchema,
  creationOptionsSchema,
  passkeyName,
  passkeySchema,
  registrationResponseSchema,
  requestOptionsSchema,
} from './passkey.schemas.js';
import { type CeremonyBinding, PasskeysService } from './passkeys.service.js';

const registerSchema = z.object({
  name: passkeyName.describe('What you call it: "MacBook", "YubiKey".'),
  response: registrationResponseSchema,
});
const renameSchema = z.object({ name: passkeyName });
const signInOptionsSchema = z.preprocess(
  (body) => body ?? {},
  z.object({
    email: email
      .optional()
      .describe(
        'The account whose passkeys to offer. Without it, the browser offers the passkeys it has for this site (usernameless; `useBrowserAutofill`).',
      ),
  }),
);
const signInSchema = z.object({ response: authenticationResponseSchema });
const tokenSchema = signInSchema.extend({
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('With two-factor on: a code from the app (or a recoveryCode).'),
  recoveryCode: z.string().max(64).optional(),
  tenantId: z
    .uuid()
    .optional()
    .describe(
      'The tenant the tokens act in (one of GET /auth/tenants); left out: the last one chosen. To act in another, sign in again with it.',
    ),
});
/**
 * The public ceremonies' own budget per address (options, browser and app
 * answers together): a usernameless sign-in names no email for the global
 * guard's `email|address` key, and one that names an email may name a new
 * one each time. 15 sign-ins (two requests each) in 15 minutes.
 */
const CEREMONIES = AddressThrottle({
  name: 'passkey',
  limit: 30,
  ttl: minutes(15),
});

const tokensSchema = z.object({
  accessToken: z.string().describe('A JWT: `Authorization: Bearer …`.'),
  refreshToken: z.string().describe('Single use: POST /auth/token/refresh.'),
  expiresIn: z.number().int(),
});

/**
 * Passkeys (WebAuthn): several named credentials per account, and signing
 * in with one. A ceremony is two requests: the options (with a one-time
 * challenge), then the authenticator's answer. Registering, renaming and
 * removing want a recent sign-in (`@RecentAuthentication()`); signing in
 * is public, limited per address (the ceremonies have their own limits:
 * usernameless, nothing but the address identifies the caller) and
 * behind the same bot check as the password sign-in.
 */
@ApiTags('auth')
@Controller('auth/passkeys')
export class PasskeysController {
  constructor(private readonly passkeys: PasskeysService) {}

  /** What the challenge is bound to: the user's session (a token client: nothing but the user), and the page's origin. */
  private binding(
    session: unknown,
    origin: string | undefined,
  ): CeremonyBinding {
    const authentication = authenticationOf(session);
    return {
      sessionId:
        authentication?.via === 'session'
          ? (session as SessionRecord).id
          : null,
      origin,
    };
  }

  @DuringOnboarding()
  @UserOnly()
  @Can.Anyone()
  @Get()
  @ApiTags('account')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Your passkeys',
    description:
      'Account-level: empty while an administrator acts as you (impersonation shows only what belongs to the tenant).',
  })
  @ApiOkResponse({ standardSchema: listSchema(passkeySchema) })
  async list(@CurrentUser() user: UserPrincipal) {
    // The account's credentials are no tenant's: an impersonating
    // administrator sees none (as the sessions list shows only its own).
    if (user.impersonator) {
      return { items: [] };
    }
    return { items: await this.passkeys.list(user.id) };
  }

  // A stolen session must not add its own passkey to the account.
  @DuringOnboarding()
  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication()
  @Post('registration/options')
  @HttpCode(200)
  @ApiTags('account')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Start registering a passkey: the options for the browser',
    description:
      'Give them to `navigator.credentials.create()` (or @simplewebauthn/browser `startRegistration`), then POST the credential to /auth/passkeys. The challenge works once, for PASSKEY_CHALLENGE_TTL_SECONDS, from this session (and this origin). User verification is required. An account whose address was never proved gets 403 `email_unverified` (verify first); not while acting as another user.',
  })
  @ApiOkResponse({ standardSchema: creationOptionsSchema })
  @ApiNotFoundResponse({ description: 'Passkeys are off (PASSKEYS=off).' })
  registrationOptions(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Headers('origin') origin: string | undefined,
  ) {
    notWhileImpersonating(user);
    return this.passkeys.registrationOptions(
      user,
      this.binding(session, origin),
    );
  }

  @DuringOnboarding()
  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication()
  @Post()
  @ApiTags('account')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Register a passkey: the credential the browser made',
    description:
      'The answer of the options from POST /auth/passkeys/registration/options, with a name. Audited; you get an email.',
  })
  @ApiCreatedResponse({ standardSchema: passkeySchema })
  @ApiBadRequestResponse({
    description:
      '`passkey_invalid` with `reason`: the challenge is unknown, used or expired (`challenge`), was made for another session or origin, the response is not for this site or ran in a frame of another origin (`cross-origin`), or the authenticator did not verify its user (`user-verification`).',
  })
  @ApiConflictResponse({
    description: '`passkey_registered`: this credential is registered already.',
  })
  register(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Body({ schema: registerSchema }) body: z.infer<typeof registerSchema>,
    @Headers('origin') origin: string | undefined,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return this.passkeys.register(
      user,
      // The Zod schema is the library's JSON shape (extension results as a loose record).
      body.response as RegistrationResponseJSON,
      body.name,
      this.binding(session, origin),
      ip,
    );
  }

  // A credential's name is what its owner reads in alerts and lists: a
  // stolen session must not relabel the passkey it added (or the owner's).
  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication()
  @Patch(':id')
  @ApiTags('account')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({ summary: 'Rename a passkey' })
  @ApiOkResponse({ standardSchema: passkeySchema })
  @ApiNotFoundResponse()
  rename(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: renameSchema }) body: z.infer<typeof renameSchema>,
  ) {
    notWhileImpersonating(user);
    return this.passkeys.rename(user, id, body.name);
  }

  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication()
  @Delete(':id')
  @HttpCode(204)
  @ApiTags('account')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Remove a passkey',
    description:
      'Not the last way to sign in (409 `last_sign_in_method`: set a password first). Audited; you get an email.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: '`last_sign_in_method`: it is your only way to sign in.',
  })
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    await this.passkeys.remove(user, id, ip);
  }

  // Usernameless: nothing but the address to count by (CEREMONIES).
  @Public()
  @CEREMONIES
  @Post('sign-in/options')
  @AllowInMaintenance()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start signing in with a passkey: the options for the browser',
    description:
      'With an `email`, the account’s passkeys are offered (`allowCredentials`); without one, the browser offers the passkeys it holds for this site (usernameless, or a sign-in field with `useBrowserAutofill`). The challenge works once, for PASSKEY_CHALLENGE_TTL_SECONDS. Then POST the assertion to /auth/passkeys/sign-in (a browser) or /auth/passkeys/token (an app).',
  })
  @ApiOkResponse({ standardSchema: requestOptionsSchema })
  @ApiNotFoundResponse({ description: 'Passkeys are off (PASSKEYS=off).' })
  @ApiTooManyRequestsResponse({
    description:
      'More than 30 passkey sign-in requests (options and answers) from this address in 15 minutes.',
  })
  signInOptions(
    @Body({ schema: signInOptionsSchema })
    body: z.infer<typeof signInOptionsSchema>,
    @Headers('origin') origin: string | undefined,
  ) {
    return this.passkeys.signInOptions(body.email, { origin });
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Captcha({ action: 'sign-in', count: 'failures' })
  // Below @Captcha, so this limit runs first: a flood is refused before any token is verified.
  @CEREMONIES
  @Post('sign-in')
  @AllowInMaintenance()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in with a passkey: sets the session cookie',
    description:
      'The assertion the browser made from the options. A passkey that verified its user (Touch ID, a PIN…) counts for both factors: with two-factor on, the session is verified at once. One that did not counts as the first factor: mfaRequired, finish with POST /auth/mfa/verify. A refused assertion is a 401 saying no more.',
  })
  @ApiOkResponse({ standardSchema: signedInSchema })
  @ApiUnauthorizedResponse({
    description:
      'The challenge is unknown, used or expired; the credential is unknown; or the assertion does not verify.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'More than 10 attempts from this address in 15 minutes, or 30 passkey sign-in requests.',
  })
  async signIn(
    @Body({ schema: signInSchema }) body: z.infer<typeof signInSchema>,
    @Headers('origin') origin: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { cookie, ...result } = await this.passkeys.signIn(
      body.response as AuthenticationResponseJSON,
      { ip, userAgent, origin },
    );
    if (cookie) {
      // The package set the pending session's cookie; the verified one,
      // later in the header, replaces it in the browser.
      res.append('Set-Cookie', cookie);
    }
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Captcha({ action: 'sign-in', count: 'failures' })
  // Below @Captcha, so this limit runs first: a flood is refused before any token is verified.
  @CEREMONIES
  @Post('token')
  @AllowInMaintenance()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in a token client with a passkey (native apps)',
    description:
      'The assertion the app made from the options (an app listed in PASSKEY_ANDROID_APPS or PASSKEY_APPLE_APPS). With two-factor on, a code (or a recoveryCode) goes with it: the token service takes no passkey as the second factor.',
  })
  @ApiOkResponse({ standardSchema: tokensSchema })
  @ApiUnauthorizedResponse({
    description:
      'The assertion was refused, or a second factor is required or wrong (`mfa_required`).',
  })
  @ApiTooManyRequestsResponse({
    description:
      'More than 10 attempts from this address in 15 minutes, or 30 passkey sign-in requests.',
  })
  issueTokens(
    @Body({ schema: tokenSchema }) body: z.infer<typeof tokenSchema>,
    @Headers('origin') origin: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string,
  ) {
    return this.passkeys.issueTokens(
      body.response as AuthenticationResponseJSON,
      { code: body.code, recoveryCode: body.recoveryCode },
      { ip, userAgent, origin },
      body.tenantId,
    );
  }

  @UserOnly()
  @Can.Anyone()
  @UserThrottle({ limit: 10, ttl: minutes(15) })
  @Post('reauthentication/options')
  @HttpCode(200)
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Start re-authenticating with a passkey: the options',
    description:
      'Your passkeys, user verification required. Then POST the assertion as `passkey` to /auth/reauthenticate. The challenge is bound to this session.',
  })
  @ApiOkResponse({ standardSchema: requestOptionsSchema })
  @ApiNotFoundResponse({ description: 'Passkeys are off (PASSKEYS=off).' })
  reauthenticationOptions(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Headers('origin') origin: string | undefined,
  ) {
    notWhileImpersonating(user);
    return this.passkeys.reauthenticationOptions(
      user,
      this.binding(session, origin),
    );
  }
}
