import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { Throttle, minutes } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { inboundKeyword } from './messaging.policy.js';
import { MessagingService } from './messaging.service.js';
import {
  InboundSignatureError,
  SMS_PROVIDER,
  type SmsProvider,
} from './providers/sms-provider.js';

/**
 * Where the SMS provider posts messages people send to the sending number
 * (docs/notifications.md, "Push and SMS"): `POST /v1/webhooks/sms/twilio`.
 * Public: the provider signs the request and the provider's adapter verifies
 * it on the bytes as received (Twilio: HMAC-SHA1 of the URL and fields with
 * the auth token), so nothing unsigned is acted on.
 *
 * STOP (and its synonyms) opts the number out of every SMS; START re-enables
 * a number that opted out, and only that. Anything else is ignored: replies
 * are not a channel. Answers 204 with no body (Twilio needs no TwiML). The
 * provider enforces the opt-out at its end too (Twilio refuses to send to a
 * number that replied STOP).
 */
@ApiTags('incoming webhooks')
@Public()
@Controller('webhooks/sms')
export class SmsInboundController {
  constructor(
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider | null,
    private readonly messaging: MessagingService,
  ) {}

  @Post(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 300, ttl: minutes(1) } })
  @ApiOperation({
    summary: 'The SMS provider reports a message sent to the number',
    description:
      '`twilio`: a form-encoded inbound message, signed with `X-Twilio-Signature` (verified with TWILIO_AUTH_TOKEN and the webhook URL). STOP opts the sender out; START opts them back in.',
  })
  @ApiBody({
    description: "The provider's form fields, as it sends them.",
    schema: { type: 'string' },
  })
  @ApiNoContentResponse({ description: 'Processed (or ignored).' })
  @ApiBadRequestResponse({ description: 'An empty body.' })
  @ApiUnauthorizedResponse({
    description: 'The signature does not verify (sms_signature_invalid).',
  })
  @ApiNotFoundResponse({
    description: 'That provider is not the configured one.',
  })
  async receive(
    @Param('provider') name: string,
    @Req() request: RawBodyRequest<IncomingMessage>,
    @Headers() headers: IncomingHttpHeaders,
  ) {
    if (
      !this.provider ||
      this.provider.name === 'memory' ||
      this.provider.name !== name
    ) {
      throw new NotFoundException('No such SMS provider is configured.');
    }
    if (!request.rawBody?.length) {
      throw new BadRequestException({
        code: 'sms_malformed',
        message: 'An empty body.',
      });
    }
    let inbound;
    try {
      inbound = this.provider.parseInbound({
        rawBody: request.rawBody,
        headers,
      });
    } catch (error) {
      if (error instanceof InboundSignatureError) {
        throw new UnauthorizedException({
          code: 'sms_signature_invalid',
          message: 'The signature does not verify.',
        });
      }
      throw error;
    }
    const keyword = inboundKeyword(inbound.body);
    if (keyword === 'stop')
      await this.messaging.optOut(inbound.from, this.provider.name);
    if (keyword === 'start')
      await this.messaging.optIn(inbound.from, this.provider.name);
  }
}
