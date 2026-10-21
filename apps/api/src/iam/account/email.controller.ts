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
  ApiConflictResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import { DuringMfaEnrollment } from '../auth/mfa-enrollment.guard.js';
import { DuringOnboarding } from '../auth/onboarding.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { Captcha } from '../captcha/captcha.guard.js';
import {
  acceptedSchema,
  email,
  notWhileImpersonating,
  token,
} from './account.schemas.js';
import { AccountService } from './account.service.js';
import { VerificationRequests } from './verification-requests.service.js';

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
const changeEmailSchema = z.object({
  email,
  currentPassword: z.string().min(1).max(256),
});
const resendSchema = z.object({ email });
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
    private readonly verificationRequests: VerificationRequests,
  ) {}

  @Public()
  @DuringOnboarding()
  @DuringMfaEnrollment()
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
  @DuringOnboarding()
  @DuringMfaEnrollment()
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

  @UserOnly()
  @Can.Anyone()
  @DuringOnboarding()
  @DuringMfaEnrollment()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Post('change')
  @HttpCode(202)
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiOperation({
    summary: "Replace the first administrator's placeholder email",
    description:
      'Only while onboarding asks for it (`GET /auth/me` `onboardingRequired.email`): 409 otherwise. Wants the current password. The address changes at once and is unproved until its link (WEB_URL/verify-email?token=…) is opened; signing in stays possible meanwhile, so a typo can be corrected by calling this again.',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  @ApiBadRequestResponse({
    description: '`placeholder_email`: the address is a placeholder.',
  })
  @ApiConflictResponse({
    description: 'No email onboarding pending, or the address is taken.',
  })
  async change(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: changeEmailSchema })
    body: z.infer<typeof changeEmailSchema>,
  ) {
    notWhileImpersonating(user);
    await this.account.changeOnboardingEmail(user, body);
    return { accepted: true as const };
  }

  // Five per email and IP every 15 minutes, as forgot password; a challenge when CAPTCHA_MODE asks.
  @Public()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'resend-verification', count: 'requests' })
  @Post('verification/resend')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send the verification link again, without a session',
    description:
      'For a sign-up whose address is not proved yet (it has no session: sign-in answers 403 `email_unverified`). Always 202, at once, whether the address has an account, a verified one or none: the answer reveals nothing. An unproved account with a password gets a new link (WEB_URL/verify-email?token=…), at most one a minute. Signed in, use POST /auth/email/verification.',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  resendByEmail(
    @Body({ schema: resendSchema }) body: z.infer<typeof resendSchema>,
  ) {
    this.verificationRequests.request(body.email);
    return { accepted: true as const };
  }
}
