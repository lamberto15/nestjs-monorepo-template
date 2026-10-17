import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  CurrentUser,
  EmailVerificationService,
  Public,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { acceptedSchema, token } from './account.schemas.js';
import { AccountService } from './account.service.js';

const verifySchema = z.object({
  token,
  password: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "The account's password, when it was chosen before the address was proved (a sign-up): required then.",
    ),
});
const verifiedSchema = z.object({
  email: z.string(),
  emailVerified: z.literal(true),
});

/**
 * Proving an address: the link (WEB_URL/verify-email?token=…) opens a page
 * that POSTs the token back. Mail scanners follow GET links, so a GET would
 * use the link up before the user clicks it.
 */
@ApiTags('account')
@Controller('auth/email')
export class EmailController {
  constructor(
    private readonly emailVerification: EmailVerificationService,
    private readonly account: AccountService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm an address with the link's token" })
  @ApiOkResponse({ standardSchema: verifiedSchema })
  @ApiBadRequestResponse({
    description:
      'Unknown, used or expired link, or the address changed since. `password_required`: the account signed up with a password, send it (a wrong one is 403 `forbidden`; the link stays usable either way).',
  })
  async verify(
    @Body({ schema: verifySchema }) body: z.infer<typeof verifySchema>,
  ) {
    const verified = await this.account.verifyEmail(body.token, body.password);
    return { email: verified.email, emailVerified: true as const };
  }

  @UserOnly()
  @Can.Anyone()
  @Throttle({ default: { limit: 3, ttl: minutes(15) } })
  @Post('verification')
  @HttpCode(202)
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({ summary: 'Send the verification link again' })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  async resend(@CurrentUser() user: UserPrincipal) {
    if (!user.emailVerified) {
      await this.emailVerification.send(user);
    }
    return { accepted: true as const };
  }
}
