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
  type SessionRecord,
  SessionService,
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
import {
  authenticationOf,
  SIGN_IN_METHODS,
} from '../auth/authentication-method.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { notWhileImpersonating } from './account.schemas.js';

const sessionSchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  userAgent: z.string().nullable(),
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

/** "Where you're signed in": the user's browser sessions, and signing out of them. */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Can.Anyone()
@Controller('auth')
export class SessionsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly signInService: SignInService,
  ) {}

  @Get('sessions')
  @ApiOperation({
    summary: 'Your browser sessions',
    description: 'While an administrator acts as you: only that session.',
  })
  @ApiOkResponse({ standardSchema: listSchema(sessionSchema) })
  async list(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() current: SessionRecord | undefined,
  ) {
    // While impersonating, only this session: the person's others (their
    // devices, their other tenants) are theirs, not the administrator's.
    const sessions = (await this.sessions.list(user.id)).filter(
      (session) => !user.impersonator || session.id === current?.id,
    );
    const items = sessions.map((session) => {
      const authentication = authenticationOf(session);
      return {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastActiveAt: session.lastActiveAt.toISOString(),
        userAgent: (session.metadata?.userAgent as string | undefined) ?? null,
        method: authentication?.method ?? null,
        provider: authentication?.provider ?? null,
        mfa: authentication?.mfa ?? false,
        authenticatedAt: authentication?.authenticatedAt?.toISOString() ?? null,
        current: session.id === current?.id,
      };
    });
    return { items };
  }

  // revoke() only ends a session of this user: another user's id is a 404.
  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign one of your sessions out' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async revoke(@CurrentUser() user: UserPrincipal, @Param('id') id: string) {
    notWhileImpersonating(user);
    if (!(await this.sessions.revoke(id, { userId: user.id }))) {
      throw new NotFoundException();
    }
  }

  @Post('sign-out-everywhere')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of every browser and every app' })
  @ApiNoContentResponse()
  async signOutEverywhere(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    await this.signInService.signOutEverywhere(user.id);
  }
}
