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
import {
  acceptedSchema,
  email,
  redirectTo,
  signedInSchema,
  token,
} from './account.schemas.js';

const requestSchema = z.object({ email, redirectTo });
const consumeSchema = z.object({ token });

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

  private enabled() {
    if (!this.config.get('AUTH_MAGIC_LINK', { infer: true })) {
      throw new NotFoundException();
    }
  }
}
