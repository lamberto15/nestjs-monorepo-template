import { createHmac, timingSafeEqual } from 'node:crypto';
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

/** Svix's default tolerance: a captured request older than this (or dated ahead) is refused. */
const TOLERANCE_SECONDS = 5 * 60;

const resendSchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z.looseObject({
    to: z.array(z.string()).optional(),
    bounce: z
      .looseObject({
        type: z.string().optional(),
        subType: z.string().optional(),
        message: z.string().optional(),
      })
      .optional(),
  }),
});

/**
 * The first address of `"Name <a@b.c>"` as Resend reports recipients, or the
 * string as it is: the text from the first `<` that isn't an empty `<>` to
 * the next `>`. Searched with indexOf, not `/<([^>]+)>/`: that regex scans
 * to the end again from every `<` of a value without a `>`, quadratic on a
 * crafted one (SonarCloud S8786).
 */
function address(value: string): string {
  let open = value.indexOf('<');
  // `<>` holds nothing: the next `<` then.
  while (open !== -1 && value.charAt(open + 1) === '>') {
    open = value.indexOf('<', open + 2);
  }
  const close = open === -1 ? -1 : value.indexOf('>', open + 1);
  return close === -1 ? value : value.slice(open + 1, close);
}

/**
 * Resend's webhooks at `POST /v1/webhooks/mail/resend`
 * (docs/deliverability.md, "Resend"). Resend signs through Svix: the headers
 * `svix-id`, `svix-timestamp` and `svix-signature` (space-separated `v1,<base64>`
 * entries, several while the secret rotates), HMAC-SHA256 of
 * `<id>.<timestamp>.<body>` keyed with the base64 after `whsec_` of the
 * signing secret (`RESEND_WEBHOOK_SECRET`). That is Svix's documented
 * manual verification (https://docs.svix.com/receiving/verifying-payloads/how-manual),
 * checked with node:crypto as the SendGrid intake is: the `svix` package
 * would add a dependency for fifteen lines, and `@nestjs/webhooks`' standard
 * scheme reads `webhook-*` headers and needs the module's receiver setup.
 *
 * Order: configured (403 `resend_not_configured`), headers and a fresh
 * timestamp (401 `resend_signature_missing`, 400 `resend_stale`), the
 * signature (401 `resend_signature_invalid`), then the body (400
 * `resend_malformed`).
 *
 * `email.bounced` is hard when Resend's bounce type is `Permanent`, soft for
 * `Transient` and `Undetermined`; `email.complained` is a complaint;
 * `email.delivered` a delivery. Everything else (sent, opened, clicked,
 * delivery_delayed, failed, suppressed…) says nothing about the mailbox: ignored.
 */
@Injectable()
export class ResendIntake implements MailEventIntake {
  readonly name = 'resend';

  constructor(
    private readonly config: ConfigService<PlatformEnv, true>,
    registry: MailEventIntakeRegistry,
  ) {
    registry.register(this);
  }

  // async so that a refusal is a rejection, as the interface promises.
  async receive({ rawBody, headers }: IntakeRequest): Promise<IntakeResult> {
    const secret = this.config.get('RESEND_WEBHOOK_SECRET', { infer: true });
    if (!secret) {
      throw new ForbiddenException({
        code: 'resend_not_configured',
        message: 'RESEND_WEBHOOK_SECRET is not set: Resend is not accepted.',
      });
    }
    const id = headers['svix-id'];
    const timestamp = headers['svix-timestamp'];
    const signature = headers['svix-signature'];
    if (
      typeof id !== 'string' ||
      typeof timestamp !== 'string' ||
      typeof signature !== 'string'
    ) {
      throw new UnauthorizedException({
        code: 'resend_signature_missing',
        message:
          'The svix-id, svix-timestamp or svix-signature header is missing.',
      });
    }
    const age = Date.now() / 1000 - Number(timestamp);
    if (!/^\d+$/.test(timestamp) || Math.abs(age) > TOLERANCE_SECONDS) {
      throw new BadRequestException({
        code: 'resend_stale',
        message: 'The request is more than five minutes off the clock.',
      });
    }
    if (!this.valid(secret, id, timestamp, signature, rawBody)) {
      throw new UnauthorizedException({
        code: 'resend_signature_invalid',
        message: 'The signature does not verify.',
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      raw = undefined;
    }
    const parsed = resendSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'resend_malformed',
        message: 'Not a Resend webhook event.',
      });
    }
    const { type, created_at, data } = parsed.data;
    const kind = this.kind(type, data.bounce?.type);
    if (!kind) return { kind: 'ignored', detail: `event-${type}` };
    const time = Date.parse(created_at ?? '');
    const occurredAt = new Date(
      Number.isNaN(time) ? Number(timestamp) * 1000 : time,
    ).toISOString();
    const detail = [
      data.bounce?.type,
      data.bounce?.subType,
      data.bounce?.message,
    ]
      .filter(Boolean)
      .join(': ')
      .slice(0, 500);
    const events: MailEvent[] = (data.to ?? []).map((to) => ({
      type: kind,
      address: address(to),
      occurredAt,
      ...(detail && kind !== 'delivery' ? { detail } : {}),
    }));
    if (events.length === 0) {
      return { kind: 'ignored', detail: 'no-recipients' };
    }
    // svix-id is the same on every redelivery of a message: the replay key.
    return { kind: 'events', id, events };
  }

  private kind(type: string, bounce?: string): MailEvent['type'] | undefined {
    switch (type) {
      case 'email.bounced':
        return bounce === 'Permanent' ? 'hard_bounce' : 'soft_bounce';
      case 'email.complained':
        return 'complaint';
      case 'email.delivered':
        return 'delivery';
      default:
        return undefined;
    }
  }

  private valid(
    secret: string,
    id: string,
    timestamp: string,
    header: string,
    rawBody: Buffer,
  ): boolean {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    if (key.length === 0) return false;
    const expected = createHmac('sha256', key)
      .update(`${id}.${timestamp}.`)
      .update(rawBody)
      .digest();
    return header
      .split(' ')
      .filter((entry) => entry.startsWith('v1,'))
      .some((entry) => {
        const given = Buffer.from(entry.slice(3), 'base64');
        return (
          given.length === expected.length && timingSafeEqual(given, expected)
        );
      });
  }
}
