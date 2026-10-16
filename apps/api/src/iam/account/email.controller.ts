import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  EmailVerificationService,
  Public,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { t } from '@nestjs/i18n';
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

const verifySchema = z.object({ token });
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
  constructor(private readonly emailVerification: EmailVerificationService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm an address with the link's token" })
  @ApiOkResponse({ standardSchema: verifiedSchema })
  @ApiBadRequestResponse({
    description: 'Unknown, used or expired link, or the address changed since.',
  })
  async verify(
    @Body({ schema: verifySchema }) body: z.infer<typeof verifySchema>,
  ) {
    const verified = await this.emailVerification.verify(body.token);
    if (!verified) {
      throw new BadRequestException(t('auth.invalidLink'));
    }
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
