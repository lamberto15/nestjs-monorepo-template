import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { Throttle, minutes } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { z } from 'zod';
import { MailEventsService } from './mail-events.service.js';

const receiptSchema = z.object({
  received: z.literal(true),
  kind: z.enum(['events', 'handshake', 'ignored']),
  events: z.number().int(),
});

/**
 * Where mail providers report bounces and complaints
 * (docs/deliverability.md): `POST /v1/webhooks/mail/ses` for Amazon SES
 * through SNS. Public: the provider signs the message and the intake
 * verifies it on the bytes as received (SNS posts JSON as text/plain, so
 * the body is read raw, never through the JSON parser).
 *
 * Not `@VerifyWebhook()`: @nestjs/webhooks checks HMAC schemes keyed on a
 * shared secret, synchronously, and SNS signs with RSA and a certificate
 * fetched from a URL the message names. The replay protection is the
 * events table's unique index (and the job id), not the inbox.
 */
@ApiTags('incoming webhooks')
@Public()
@Controller('webhooks/mail')
export class MailEventsController {
  constructor(private readonly events: MailEventsService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  // SNS retries on a 5xx and 429; this bounds a flood from anyone else.
  @Throttle({ default: { limit: 300, ttl: minutes(1) } })
  @ApiOperation({
    summary: 'A mail provider reports bounces and complaints',
    description:
      '`ses`: an SNS HTTP(S) notification (JSON, sent as text/plain) from one of SES_SNS_TOPIC_ARNS, signed by SNS (SignatureVersion 1 or 2). A `SubscriptionConfirmation` from an allowed topic is confirmed; a `Notification` carrying SES bounces, complaints or deliveries is queued for the suppression list. Nothing is written in the request.',
  })
  @ApiParam({ name: 'provider', example: 'ses' })
  @ApiBody({
    description: 'The provider’s notification, as it sends it.',
    schema: { type: 'string' },
  })
  @ApiOkResponse({ standardSchema: receiptSchema })
  @ApiBadRequestResponse({
    description: 'Not the provider’s format (sns_malformed).',
  })
  @ApiUnauthorizedResponse({
    description:
      'The signature does not verify (sns_signature_invalid), or the certificate or subscribe URL is not an SNS host (sns_certificate_refused, sns_subscribe_url_refused).',
  })
  @ApiForbiddenResponse({
    description:
      'The topic is not in SES_SNS_TOPIC_ARNS (sns_topic_not_allowed).',
  })
  @ApiNotFoundResponse({ description: 'No such provider.' })
  @ApiServiceUnavailableResponse({
    description:
      'The signing certificate could not be fetched (sns_certificate_unavailable): the provider retries.',
  })
  handle(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<IncomingMessage>,
    @Headers() headers: IncomingHttpHeaders,
  ) {
    if (!request.rawBody || request.rawBody.length === 0) {
      throw new BadRequestException({
        code: 'sns_malformed',
        message: 'An empty body.',
      });
    }
    return this.events.receive(provider, { rawBody: request.rawBody, headers });
  }
}
