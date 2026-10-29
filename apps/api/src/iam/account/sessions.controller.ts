import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  SignInService,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { SIGN_IN_METHODS } from '../auth/authentication-method.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { DuringMfaEnrollment } from '../auth/mfa-enrollment.guard.js';
import { DuringOnboarding } from '../auth/onboarding.js';
import { AccountService } from './account.service.js';
import { notWhileImpersonating } from './account.schemas.js';
import { WithoutSso } from '../sso/sso-required.guard.js';

const sessionSchema = z.object({
  id: z
    .string()
    .describe(
      "A browser session's id, or an app's (its token family's `sid`).",
    ),
  kind: z
    .enum(['browser', 'app'])
    .describe(
      '`browser`: a cookie session; `app`: a token client (POST /auth/token and the other token sign-ins).',
    ),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso
    .datetime()
    .describe(
      "The last request (a browser's), or the last refresh (an app's).",
    ),
  userAgent: z
    .string()
    .nullable()
    .describe("A browser's recorded user agent; null for an app."),
  device: z
    .string()
    .nullable()
    .describe(
      'A readable summary of the user agent ("Chrome on macOS", "NestJSMobile on iOS"); null when none was recorded.',
    ),
  method: z
    .enum(SIGN_IN_METHODS)
    .nullable()
    .describe(
      'How it was signed in (`impersonation`: an administrator acting as you); null: before this was recorded.',
    ),
  provider: z
    .string()
    .nullable()
    .describe('The provider (`google`) of an `oidc` sign-in.'),
  mfa: z.boolean().describe('A second factor was verified.'),
  authenticatedAt: z.iso
    .datetime()
    .nullable()
    .describe('The sign-in, or the last re-authentication.'),
  current: z.boolean(),
});

/** "Where you're signed in": the user's browser sessions and apps, and signing out of them. */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Can.Anyone()
@Controller('auth')
export class SessionsController {
  constructor(
    private readonly account: AccountService,
    private readonly signInService: SignInService,
  ) {}

  @Get('sessions')
  @ApiOperation({
    summary: 'Where you are signed in: your browser sessions and apps',
    description:
      'Browsers first, then apps (token clients still signed in). `current`: the session or app of this request. While an administrator acts as you: only that session.',
  })
  @ApiOkResponse({ standardSchema: listSchema(sessionSchema) })
  async list(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() current: unknown,
  ) {
    const items = await this.account.listSessions(user, current);
    return { items };
  }

  // Only a session or app of this user: another user's id is a 404.
  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Sign one of your sessions or apps out',
    description:
      'An app (its token family) is signed out at once: its refresh token stops working, its realtime connections end; an access token it holds lives until it expires (15 minutes).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async revoke(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    notWhileImpersonating(user);
    if (!(await this.account.revokeSession(user, id))) {
      throw new NotFoundException();
    }
  }

  @DuringMfaEnrollment()
  @DuringOnboarding()
  @WithoutSso()
  @Post('sign-out-everywhere')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of every browser and every app' })
  @ApiNoContentResponse()
  async signOutEverywhere(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    await this.signInService.signOutEverywhere(user.id);
  }
}
