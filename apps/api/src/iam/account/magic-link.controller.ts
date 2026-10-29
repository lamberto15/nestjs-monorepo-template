import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Ip,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { MagicLinkService, Public } from '@nestjs/authentication';
import { ConfigService } from '@nestjs/config';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { Captcha } from '../captcha/captcha.guard.js';
import type { IamEnv } from '../iam.env.js';
import { AccountService } from './account.service.js';
import { NativeSignIn } from './native-sign-in.service.js';
import { codeChallenge } from './native-redirect.js';
import {
  acceptedSchema,
  email,
  redirectTo,
  signedInSchema,
  token,
} from './account.schemas.js';

const requestSchema = z.object({ email, redirectTo });
const consumeSchema = z.object({ token });
const handoffSchema = z.object({ token, codeChallenge });
const handoffCodeSchema = z.object({
  code: z
    .string()
    .describe(
      'One-time, for a minute: POST /auth/token/exchange with the `codeVerifier`.',
    ),
});

/**
 * Passwordless sign-in (AUTH_MAGIC_LINK=on): a link by email, for accounts
 * whose address is verified. It works once, for 15 minutes, in the browser
 * that asked for it (a cookie binds them).
 */
@ApiTags('auth')
@Public()
@Controller('auth/magic-link')
export class MagicLinkController {
  constructor(
    private readonly magicLinks: MagicLinkService,
    private readonly account: AccountService,
    private readonly config: ConfigService<IamEnv, true>,
    private readonly native: NativeSignIn,
  ) {}

  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'magic-link', count: 'requests' })
  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Email a sign-in link',
    description:
      'Always 202: the answer reveals nothing. The link opens WEB_URL/magic-link?token=…, which POSTs to /auth/magic-link/verify from the same browser.',
  })
  @ApiAcceptedResponse({ standardSchema: acceptedSchema })
  async request(
    @Body({ schema: requestSchema }) body: z.infer<typeof requestSchema>,
  ) {
    this.enabled();
    await this.magicLinks.create(body.email, { redirectTo: body.redirectTo });
    return { accepted: true as const };
  }

  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  // Only the link already mailed: asking for one needs the mail queue, paused while restricted.
  @AllowInMaintenance()
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({
    summary: "Sign in with the link's token: sets the session cookie",
  })
  @ApiOkResponse({ standardSchema: signedInSchema })
  @ApiUnauthorizedResponse({
    description: 'Unknown, used or expired link, or another browser.',
  })
  consume(
    @Body({ schema: consumeSchema }) body: z.infer<typeof consumeSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    this.enabled();
    return this.account.signInWithMagicLink(body.token, { ip, userAgent });
  }

  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @AllowInMaintenance()
  @Post('handoff')
  @HttpCode(200)
  @ApiOperation({
    summary: "A native app's sign-in with the link's token: a one-time code",
    description:
      "For an app that opens the link itself (a universal / app link on WEB_URL/magic-link) and asked for it with POST /auth/magic-link, keeping that response's cookie (the link works only where it was asked for). Spends the link, starts no session, and answers a code for POST /auth/token/exchange, bound to `codeChallenge` (PKCE).",
  })
  @ApiOkResponse({ standardSchema: handoffCodeSchema })
  @ApiUnauthorizedResponse({
    description: 'Unknown, used or expired link, or asked for elsewhere.',
  })
  handoff(
    @Body({ schema: handoffSchema }) body: z.infer<typeof handoffSchema>,
  ) {
    this.enabled();
    return this.native.handOffMagicLink(body.token, body.codeChallenge);
  }

  private enabled() {
    if (!this.config.get('AUTH_MAGIC_LINK', { infer: true })) {
      throw new NotFoundException();
    }
  }
}
