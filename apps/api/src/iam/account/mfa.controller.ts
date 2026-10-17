import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Post,
} from '@nestjs/common';
import {
  CurrentUser,
  MfaAlreadyEnrolledError,
  MfaService,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { ConflictException } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { UserPrincipal } from '../auth/principal.js';
import { RequiresSwitch } from '../auth/deployment-switch.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { notWhileImpersonating, verifiedEmailOnly } from './account.schemas.js';
import { AccountService } from './account.service.js';

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const statusSchema = z.object({
  enabled: z.boolean(),
  remainingRecoveryCodes: z.number().int(),
});
const enrollmentSchema = z.object({
  secret: z.string().describe('Base32, for typing into the app by hand.'),
  uri: z.string().describe('otpauth:// URI: show it as a QR code.'),
});
const recoveryCodesSchema = z.object({
  recoveryCodes: z
    .array(z.string())
    .describe('Shown once: each one signs in once in place of a code.'),
});

/**
 * Two-factor authentication with an authenticator app (TOTP) and recovery
 * codes (MfaService). Enroll, confirm with a first code: from then on, a
 * sign-in asks for a code (POST /auth/mfa/verify). Changing or removing it
 * needs a session that passed the second factor; setting it up, new recovery
 * codes and turning it off want a recent sign-in (`@RecentAuthentication()`).
 */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@Can.Anyone()
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly account: AccountService,
  ) {}

  @UserOnly()
  @Get()
  @ApiOperation({ summary: 'Whether two-factor is on' })
  @ApiOkResponse({ standardSchema: statusSchema })
  async status(@CurrentUser() user: UserPrincipal) {
    return {
      enabled: await this.mfa.isEnrolled(user.id),
      remainingRecoveryCodes: await this.mfa.remainingRecoveryCodes(user.id),
    };
  }

  // A stolen session must not put its own authenticator on the account (and lock its owner out).
  @UserOnly()
  @RecentAuthentication()
  @Post('enroll')
  @RequiresSwitch('AUTH_MFA')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start setting up an authenticator app' })
  @ApiOkResponse({ standardSchema: enrollmentSchema })
  @ApiConflictResponse({
    description: 'Two-factor is already on: turn it off first.',
  })
  async enroll(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    verifiedEmailOnly(user);
    try {
      return await this.mfa.enroll(user.id, user.email);
    } catch (error) {
      if (error instanceof MfaAlreadyEnrolledError) {
        throw new ConflictException('Two-factor is already on.');
      }
      throw error;
    }
  }

  @UserOnly()
  @Post('confirm')
  @RequiresSwitch('AUTH_MFA')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Turn two-factor on with a first code from the app',
    description:
      'Returns the recovery codes, once. This browser counts as verified.',
  })
  @ApiOkResponse({ standardSchema: recoveryCodesSchema })
  async confirm(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: codeSchema }) body: z.infer<typeof codeSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return {
      recoveryCodes: await this.account.enableMfa(user, body.code, ip),
    };
  }

  @UserOnly({ mfa: true })
  @RecentAuthentication()
  @Post('recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: 'New recovery codes (the old ones stop working)' })
  @ApiOkResponse({ standardSchema: recoveryCodesSchema })
  async recoveryCodes(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    return { recoveryCodes: await this.mfa.generateRecoveryCodes(user.id) };
  }

  @UserOnly({ mfa: true })
  @RecentAuthentication()
  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Turn two-factor off' })
  @ApiNoContentResponse()
  async disable(@CurrentUser() user: UserPrincipal, @Ip() ip: string) {
    notWhileImpersonating(user);
    await this.account.disableMfa(user, ip);
  }
}
