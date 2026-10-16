import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../../platform.env.js';
import type {
  IntakeRequest,
  IntakeResult,
  MailEventIntake,
} from '../mail-event.types.js';
import { MailEventIntakeRegistry } from '../mail-events.service.js';
import { sesEvents } from './ses-message.js';
import { SnsGateway } from './sns-gateway.js';
import {
  isSnsUrl,
  type SnsMessage,
  snsMessageSchema,
  snsSignatureValid,
  snsTimestampFresh,
} from './sns-message.js';

/**
 * Amazon SES, through SNS: SES publishes bounces and complaints to a
 * topic, the topic POSTs them here (docs/deliverability.md, "Amazon SES").
 * Every message is checked, in this order, before anything else happens:
 *
 * 1. It is SNS's JSON (400 `sns_malformed` otherwise), with a Timestamp
 *    of the last hour (400 `sns_stale`: a captured message can't be
 *    replayed once the events table has forgotten it), and signed with
 *    version 2 when SES_SNS_REQUIRE_SIGNATURE_V2 is on (401
 *    `sns_signature_version_refused`).
 * 2. Its certificate URL is https on an `sns.<region>.amazonaws.com`
 *    host at `/SimpleNotificationService-<id>.pem` (401
 *    `sns_certificate_refused`): nothing else is ever fetched, whatever
 *    the message says; the certificate must be small and valid now.
 * 3. Its topic is one of SES_SNS_TOPIC_ARNS (403 `sns_topic_not_allowed`),
 *    before the certificate is fetched: an unknown topic costs no request.
 * 4. Its signature (version 1 or 2) verifies with that certificate
 *    (401 `sns_signature_invalid`; 503 `sns_certificate_unavailable`
 *    while the certificate can't be fetched, so SNS retries).
 *
 * Then a `SubscriptionConfirmation` is confirmed by visiting its
 * `SubscribeURL`, if that too is on an SNS host; an
 * `UnsubscribeConfirmation` is logged and nothing is visited (a visit
 * would re-subscribe); a `Notification` becomes events for the queue.
 */
@Injectable()
export class SesIntake implements MailEventIntake {
  readonly name = 'ses';
  private readonly logger = new Logger('SesIntake');

  constructor(
    private readonly gateway: SnsGateway,
    private readonly config: ConfigService<PlatformEnv, true>,
    registry: MailEventIntakeRegistry,
  ) {
    registry.register(this);
  }

  /** The topics SES publishes to; empty, every message is refused. */
  private get topics(): readonly string[] {
    return this.config.get('SES_SNS_TOPIC_ARNS', { infer: true });
  }

  async receive({ rawBody }: IntakeRequest): Promise<IntakeResult> {
    const message = this.parse(rawBody);
    if (!snsTimestampFresh(message.Timestamp)) {
      throw new BadRequestException({
        code: 'sns_stale',
        message: 'The message is older than an hour, or dated in the future.',
      });
    }
    if (
      message.SignatureVersion === '1' &&
      this.config.get('SES_SNS_REQUIRE_SIGNATURE_V2', { infer: true })
    ) {
      throw new UnauthorizedException({
        code: 'sns_signature_version_refused',
        message: 'SignatureVersion 1 is refused: set the topic to 2.',
      });
    }
    if (!isSnsUrl(message.SigningCertURL, { certificate: true })) {
      throw new UnauthorizedException({
        code: 'sns_certificate_refused',
        message: 'The signing certificate URL is not an SNS host.',
      });
    }
    if (!this.topics.includes(message.TopicArn)) {
      throw new ForbiddenException({
        code: 'sns_topic_not_allowed',
        message: 'Notifications from this topic are not accepted.',
      });
    }
    await this.verify(message);
    switch (message.Type) {
      case 'SubscriptionConfirmation':
        return this.subscribe(message);
      case 'UnsubscribeConfirmation':
        // Nothing visited: SNS re-subscribes on a visit to this one's SubscribeURL.
        this.logger.warn('SNS subscription ended: bounces no longer arrive', {
          topic: message.TopicArn,
        });
        return { kind: 'ignored', detail: 'unsubscribe-confirmation' };
      case 'Notification': {
        const events = sesEvents(message.Message);
        if (events === undefined) {
          return { kind: 'ignored', detail: 'not-an-ses-message' };
        }
        if (events.length === 0) {
          return { kind: 'ignored', detail: 'no-recipients' };
        }
        return { kind: 'events', id: message.MessageId, events };
      }
    }
  }

  private parse(rawBody: Buffer): SnsMessage {
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      raw = undefined;
    }
    const parsed = snsMessageSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'sns_malformed',
        message: 'Not an SNS message.',
      });
    }
    return parsed.data;
  }

  private async verify(message: SnsMessage) {
    let key;
    try {
      key = await this.gateway.certificate(message.SigningCertURL);
    } catch (error) {
      this.logger.warn(
        `SNS signing certificate not fetched: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        code: 'sns_certificate_unavailable',
        message: 'The signing certificate could not be fetched: try again.',
      });
    }
    if (!snsSignatureValid(message, key)) {
      throw new UnauthorizedException({
        code: 'sns_signature_invalid',
        message: 'The signature does not verify.',
      });
    }
  }

  private async subscribe(message: SnsMessage): Promise<IntakeResult> {
    if (!message.SubscribeURL || !isSnsUrl(message.SubscribeURL)) {
      throw new UnauthorizedException({
        code: 'sns_subscribe_url_refused',
        message: 'The SubscribeURL is not an SNS host.',
      });
    }
    await this.gateway.confirm(message.SubscribeURL);
    this.logger.log('SNS subscription confirmed', { topic: message.TopicArn });
    return { kind: 'handshake', detail: 'subscription-confirmed' };
  }
}
