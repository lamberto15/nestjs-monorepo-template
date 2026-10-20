import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { PlatformEnv } from '../../platform.env.js';
import type {
  IntakeRequest,
  IntakeResult,
  MailEvent,
  MailEventIntake,
} from '../mail-event.types.js';
import { MailEventIntakeRegistry } from '../mail-events.service.js';

const SIGNATURE = 'x-twilio-email-event-webhook-signature';
const TIMESTAMP = 'x-twilio-email-event-webhook-timestamp';
/** SendGrid retries for up to 24 hours; a captured request older than this hour is not replayed. */
const MAX_AGE_SECONDS = 60 * 60;
const MAX_AHEAD_SECONDS = 5 * 60;

const eventSchema = z.looseObject({
  email: z.string().min(1),
  timestamp: z.number(),
  event: z.string(),
  type: z.string().optional(),
  reason: z.string().optional(),
  status: z.string().optional(),
});
const bodySchema = z.array(eventSchema);

/**
 * SendGrid's Event Webhook at `POST /v1/webhooks/mail/sendgrid`
 * (docs/deliverability.md, "SendGrid"). Signed Event Webhook: ECDSA over
 * SHA-256 of `timestamp + body`, the signature (base64 DER) and timestamp
 * in `X-Twilio-Email-Event-Webhook-Signature` and `-Timestamp`, verified
 * with the public key the console shows (`SENDGRID_WEBHOOK_PUBLIC_KEY`,
 * base64 SPKI). Checked with node:crypto: that is all the official
 * `@sendgrid/eventwebhook` helper does, without its elliptic dependency.
 *
 * Order: configured (403 `sendgrid_not_configured`), headers and a fresh
 * timestamp (401 `sendgrid_signature_missing`, 400 `sendgrid_stale`), the
 * signature (401 `sendgrid_signature_invalid`), then the body (400
 * `sendgrid_malformed`).
 *
 * `bounce` (a permanent failure) is a hard bounce, `blocked` a soft one,
 * `spamreport` a complaint, `delivered` a delivery. `dropped` (SendGrid
 * refused it itself, usually because of its own suppression list) and
 * `deferred` (it will retry) say nothing about the mailbox: ignored.
 */
@Injectable()
export class SendGridIntake implements MailEventIntake {
  readonly name = 'sendgrid';

  constructor(
    private readonly config: ConfigService<PlatformEnv, true>,
    registry: MailEventIntakeRegistry,
  ) {
    registry.register(this);
  }

  // async so that a refusal is a rejection, as the interface promises.
  async receive({ rawBody, headers }: IntakeRequest): Promise<IntakeResult> {
    const publicKey = this.config.get('SENDGRID_WEBHOOK_PUBLIC_KEY', {
      infer: true,
    });
    if (!publicKey) {
      throw new ForbiddenException({
        code: 'sendgrid_not_configured',
        message:
          'SENDGRID_WEBHOOK_PUBLIC_KEY is not set: SendGrid is not accepted.',
      });
    }
    const signature = headers[SIGNATURE];
    const timestamp = headers[TIMESTAMP];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      throw new UnauthorizedException({
        code: 'sendgrid_signature_missing',
        message: 'The signature headers are missing.',
      });
    }
    const age = Date.now() / 1000 - Number(timestamp);
    if (
      !Number.isFinite(age) ||
      age > MAX_AGE_SECONDS ||
      age < -MAX_AHEAD_SECONDS
    ) {
      throw new BadRequestException({
        code: 'sendgrid_stale',
        message: 'The request is older than an hour, or dated in the future.',
      });
    }
    if (!this.valid(publicKey, signature, timestamp, rawBody)) {
      throw new UnauthorizedException({
        code: 'sendgrid_signature_invalid',
        message: 'The signature does not verify.',
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      raw = undefined;
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'sendgrid_malformed',
        message: 'Not an array of SendGrid events.',
      });
    }
    const events: MailEvent[] = [];
    for (const item of parsed.data) {
      const type = (
        {
          bounce: 'hard_bounce',
          blocked: 'soft_bounce',
          spamreport: 'complaint',
          delivered: 'delivery',
        } as const
      )[item.event as 'bounce'];
      if (!type) continue;
      const detail = [item.reason, item.status].filter(Boolean).join(' ');
      events.push({
        type,
        address: item.email,
        occurredAt: new Date(item.timestamp * 1000).toISOString(),
        ...(detail ? { detail: detail.slice(0, 500) } : {}),
      });
    }
    if (events.length === 0) {
      return { kind: 'ignored', detail: 'no-delivery-events' };
    }
    // The same request redelivered has the same bytes: the replay key.
    const id = createHash('sha256').update(rawBody).digest('hex');
    return { kind: 'events', id, events };
  }

  private valid(
    publicKey: string,
    signature: string,
    timestamp: string,
    rawBody: Buffer,
  ): boolean {
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return verify(
        'sha256',
        Buffer.concat([Buffer.from(timestamp), rawBody]),
        key,
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return false;
    }
  }
}
