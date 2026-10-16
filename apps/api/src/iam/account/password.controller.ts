import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import { AccountService } from './account.service.js';
import {
  CurrentSession,
  CurrentUser,
  PasswordResetService,
  Public,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import type { UserPrincipal } from '../auth/principal.js';
import { Captcha } from '../captcha/captcha.guard.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import {
  acceptedSchema,
  email,
  newPassword,
  notWhileImpersonating,
  token,
} from './account.schemas.js';

const forgotSchema = z.object({ email });
const resetSchema = z.object({ token, password: newPassword });
const changeSchema = z.object({
  currentPassword: z
    .string()
    .max(256)
    .optional()
    .describe('Required when the account has a password.'),
  newPassword,
});

/**
 * Passwords: "forgot your password?", the reset and invitation links, and a
 * change by the signed-in user. Links are single-use, expire in an hour, and
 * stop working once the password changes (PasswordResetService).
 */
@ApiTags('account')
@Controller('auth/password')
export class PasswordController {
  constructor(
    private readonly account: AccountService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'forgot-password', count: 'requests' })
  @Post('forgot')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Email a reset link',
    description:
      'Always 202, at once, whether the address has an account or not: the answer reveals nothing. The link opens WEB_URL/reset-password?token=…, which POSTs to /auth/password/reset.',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  forgot(@Body({ schema: forgotSchema }) body: z.infer<typeof forgotSchema>) {
    this.passwordReset.request(body.email);
    return { accepted: true as const };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Post('reset')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Set a new password with a reset or invitation link',
    description:
      'Signs the account out everywhere (whoever knew the old password too), and marks the address verified: the link proved it.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      'Unknown, used or expired link; or `password_breached`: the password is in known data breaches (the link still works).',
  })
  async reset(
    @Body({ schema: resetSchema }) body: z.infer<typeof resetSchema>,
    @Ip() ip: string,
  ) {
    await this.account.resetPassword(body.token, body.password, ip);
  }

  // Step-up too: an account without a password gets its first one here,
  // with no current password to check.
  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Post('change')
  @HttpCode(204)
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Wants a recent sign-in (`reauthentication_required`). Every other session and every token client is signed out; this browser keeps its session, under a new id.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      '`password_breached`: the new password is in known data breaches.',
  })
  @ApiForbiddenResponse({
    description: 'Wrong current password, or an administrator acting as you.',
  })
  async change(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord | undefined,
    @Body({ schema: changeSchema }) body: z.infer<typeof changeSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    await this.account.changePassword(user, session, body, ip);
  }
}
