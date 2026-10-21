import { timingSafeEqual } from 'node:crypto';
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

/**
 * Postmark's bounce `Type`s that mean the mailbox is gone or the address is
 * unusable, and those that are a refusal of this one mail. Everything else
 * (Unsubscribe, Subscribe, AutoResponder, AddressChange, OpenRelayTest,
 * VirusNotification, ChallengeVerification, SMTPApiError, InboundError,
 * TemplateRenderingFailed…) says nothing about the mailbox and is ignored.
 * https://postmarkapp.com/developer/api/bounce-api#bounce-types
 */
const HARD = new Set(['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated']);
const SOFT = new Set([
  'SoftBounce',
  'Transient',
  'DnsError',
  'Unknown',
  'Blocked',
  'DMARCPolicy',
]);
const COMPLAINT = new Set(['SpamNotification', 'SpamComplaint']);

const postmarkSchema = z.discriminatedUnion('RecordType', [
  z.object({
    RecordType: z.literal('Bounce'),
    ID: z.union([z.number(), z.string()]),
    Type: z.string(),
    Email: z.string().min(1),
    BouncedAt: z.string(),
    Details: z.string().optional(),
    Description: z.string().optional(),
  }),
  z.object({
    RecordType: z.literal('SpamComplaint'),
    ID: z.union([z.number(), z.string()]),
    Email: z.string().min(1),
    BouncedAt: z.string(),
  }),
  z.object({
    RecordType: z.literal('Delivery'),
    MessageID: z.string().min(1),
    Recipient: z.string().min(1),
    DeliveredAt: z.string(),
  }),
]);

/** An ISO 8601 time from the provider's (7 fraction digits, an offset), or '' when it isn't a date. */
function iso(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? '' : new Date(time).toISOString();
}

/** A constant-time comparison that doesn't leak the length either. */
function same(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Postmark's webhooks (Bounce, Spam complaint and Delivery) at
 * `POST /v1/webhooks/mail/postmark` (docs/deliverability.md, "Postmark").
 *
 * Custom code, not `@VerifyWebhook()`: Postmark does not sign its webhooks.
 * Its documented protections are HTTP Basic Auth in the URL and custom
 * headers, so the shared secret `POSTMARK_WEBHOOK_SECRET` is accepted as the
 * Basic password (any user name) or in `X-Postmark-Webhook-Secret`. Order of
 * checks as in the SES intake: format of the source (is one configured: 403
 * `postmark_not_configured`), the secret (401 `postmark_secret_invalid`),
 * then the body (400 `postmark_malformed`).
 */
@Injectable()
export class PostmarkIntake implements MailEventIntake {
  readonly name = 'postmark';

  constructor(
    private readonly config: ConfigService<PlatformEnv, true>,
    registry: MailEventIntakeRegistry,
  ) {
    registry.register(this);
  }

  // async so that a refusal is a rejection, as the interface promises.
  async receive({ rawBody, headers }: IntakeRequest): Promise<IntakeResult> {
    const secret = this.config.get('POSTMARK_WEBHOOK_SECRET', { infer: true });
    if (!secret) {
      throw new ForbiddenException({
        code: 'postmark_not_configured',
        message:
          'POSTMARK_WEBHOOK_SECRET is not set: Postmark is not accepted.',
      });
    }
    const header = headers['x-postmark-webhook-secret'];
    // The credentials start at the first character after the spaces: the two
    // quantifiers share none, so the match is linear (SonarCloud S8786).
    const basic = /^Basic\s+(\S.*)$/i.exec(headers.authorization ?? '')?.[1];
    // user:password; the user name is whatever the URL carries.
    const password = basic
      ? Buffer.from(basic, 'base64')
          .toString('utf8')
          .split(':')
          .slice(1)
          .join(':')
      : undefined;
    const given = typeof header === 'string' ? header : password;
    if (given === undefined || !same(given, secret)) {
      throw new UnauthorizedException({
        code: 'postmark_secret_invalid',
        message: 'The webhook secret is missing or wrong.',
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      raw = undefined;
    }
    const parsed = postmarkSchema.safeParse(raw);
    if (!parsed.success) {
      // A record type this intake doesn't read (Open, Click…) is authentic and harmless.
      const type = (raw as { RecordType?: unknown } | undefined)?.RecordType;
      if (
        typeof type === 'string' &&
        !['Bounce', 'SpamComplaint', 'Delivery'].includes(type)
      ) {
        return { kind: 'ignored', detail: `record-${type}` };
      }
      throw new BadRequestException({
        code: 'postmark_malformed',
        message: 'Not a Postmark Bounce, SpamComplaint or Delivery record.',
      });
    }
    const record = parsed.data;
    let event: MailEvent | undefined;
    let id: string;
    switch (record.RecordType) {
      case 'Delivery':
        id = `delivery-${record.MessageID}`;
        event = {
          type: 'delivery',
          address: record.Recipient,
          occurredAt: iso(record.DeliveredAt),
        };
        break;
      case 'SpamComplaint':
        id = `complaint-${record.ID}`;
        event = {
          type: 'complaint',
          address: record.Email,
          occurredAt: iso(record.BouncedAt),
        };
        break;
      case 'Bounce': {
        id = `bounce-${record.ID}`;
        const type = COMPLAINT.has(record.Type)
          ? 'complaint'
          : HARD.has(record.Type)
            ? 'hard_bounce'
            : SOFT.has(record.Type)
              ? 'soft_bounce'
              : undefined;
        if (type) {
          event = {
            type,
            address: record.Email,
            occurredAt: iso(record.BouncedAt),
            detail: [record.Type, record.Details ?? record.Description]
              .filter(Boolean)
              .join(': ')
              .slice(0, 500),
          };
        }
      }
    }
    if (!event || event.occurredAt === '') {
      return {
        kind: 'ignored',
        detail: 'not-a-delivery-event',
      };
    }
    return { kind: 'events', id, events: [event] };
  }
}
