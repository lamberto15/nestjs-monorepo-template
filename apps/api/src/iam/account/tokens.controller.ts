import { Body, Controller, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import {
  AuthenticationError,
  Public,
  TokenService,
} from '@nestjs/authentication';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import { Captcha } from '../captcha/captcha.guard.js';
import { CaptchaService } from '../captcha/captcha.service.js';
import { email } from './account.schemas.js';
import { AccountService } from './account.service.js';

const issueSchema = z.object({
  email,
  password: z.string().min(1).max(256),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('With two-factor on: a code from the app.'),
  recoveryCode: z.string().max(64).optional(),
  tenantId: z
    .uuid()
    .optional()
    .describe(
      'The tenant the tokens act in (one of GET /auth/tenants); left out: the last one chosen. To act in another, sign in again with it.',
    ),
});
const refreshSchema = z.object({ refreshToken: z.string().min(1).max(512) });
const tokensSchema = z.object({
  accessToken: z.string().describe('A JWT: `Authorization: Bearer …`.'),
  refreshToken: z.string().describe('Single use: POST /auth/token/refresh.'),
  expiresIn: z
    .number()
    .int()
    .describe('Seconds until the access token expires.'),
});

/**
 * Tokens for mobile apps and CLIs, which keep no cookies: a 15-minute access
 * token and a single-use refresh token. A refresh token presented twice
 * revokes its whole family (someone copied it). A user with two-factor on
 * sends a code too; without it, the answer is a 401 saying `mfa_required`.
 *
 * The same bot protection as the browser's sign-in (@Captcha, the same
 * failure counters per address and per email and address): a native app
 * renders the Turnstile widget in a web view when a 403 captcha_required
 * asks (docs/auth.md, "Bot protection").
 */
@ApiTags('auth')
@Public()
@Controller('auth/token')
export class TokensController {
  constructor(
    private readonly tokens: TokenService,
    private readonly account: AccountService,
    private readonly captcha: CaptchaService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'sign-in', count: 'failures' })
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in a token client with a password' })
  @ApiOkResponse({ standardSchema: tokensSchema })
  @ApiUnauthorizedResponse({
    description:
      'Invalid credentials, or a second factor is required or wrong.',
  })
  async issue(
    @Body({ schema: issueSchema }) body: z.infer<typeof issueSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    try {
      return await this.account.issueTokens(
        body.email,
        body.password,
        { code: body.code, recoveryCode: body.recoveryCode },
        { ip, userAgent },
        body.tenantId,
      );
    } catch (error) {
      // The right password, no code sent: the browser's sign-in answers
      // that with a 200 (`mfaRequired`), and it is no failure here either.
      // The 401 keeps the attempt the guard reserved: give it back. A wrong
      // code (the same `mfa_required`, with a code) stays counted.
      if (
        error instanceof AuthenticationError &&
        error.code === 'mfa_required' &&
        !body.code &&
        !body.recoveryCode
      ) {
        await this.captcha.release({ ip, email: body.email });
      }
      throw error;
    }
  }

  // An unknown, expired or reused refresh token gets a 401.
  @Throttle({ default: { limit: 60, ttl: minutes(1) } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Renew the access token (rotates the refresh token)',
  })
  @ApiOkResponse({ standardSchema: tokensSchema })
  @ApiUnauthorizedResponse({
    description: 'Unknown, expired or reused refresh token.',
  })
  refresh(
    @Body({ schema: refreshSchema }) body: z.infer<typeof refreshSchema>,
  ) {
    return this.tokens.refresh(body.refreshToken);
  }

  @Post('revoke')
  @HttpCode(204)
  @ApiOperation({ summary: "Sign this app out (its refresh token's family)" })
  @ApiNoContentResponse()
  async revoke(
    @Body({ schema: refreshSchema }) body: z.infer<typeof refreshSchema>,
  ) {
    // RFC 7009: the answer is the same for unknown tokens.
    await this.tokens.revoke(body.refreshToken);
  }
}
