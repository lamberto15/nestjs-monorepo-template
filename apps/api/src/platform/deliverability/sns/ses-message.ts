import { z } from 'zod';
import type { MailEvent } from '../mail-event.types.js';

/**
 * What SES puts in an SNS message: a feedback notification
 * (`notificationType`: https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html)
 * or an event-publishing record (`eventType`, the same objects). Loose:
 * SES adds fields; only what the suppression list reads is declared.
 */
const bouncedRecipient = z.looseObject({
  emailAddress: z.string().min(1),
  diagnosticCode: z.string().optional(),
  status: z.string().optional(),
});

const sesMessageSchema = z.looseObject({
  notificationType: z.string().optional(),
  eventType: z.string().optional(),
  mail: z.looseObject({ timestamp: z.string().optional() }).optional(),
  bounce: z
    .looseObject({
      /** `Permanent`, `Transient` or `Undetermined`. */
      bounceType: z.string(),
      bounceSubType: z.string().optional(),
      bouncedRecipients: z.array(bouncedRecipient),
      timestamp: z.string().optional(),
    })
    .optional(),
  complaint: z
    .looseObject({
      complainedRecipients: z.array(
        z.looseObject({ emailAddress: z.string().min(1) }),
      ),
      complaintFeedbackType: z.string().optional(),
      timestamp: z.string().optional(),
    })
    .optional(),
  delivery: z
    .looseObject({
      recipients: z.array(z.string().min(1)),
      timestamp: z.string().optional(),
    })
    .optional(),
});

/** The provider's words, kept short for the trail. */
const detail = (...parts: (string | undefined)[]) => {
  const text = parts.filter(Boolean).join(': ');
  return text ? text.slice(0, 500) : undefined;
};

/**
 * The events in an SES message, or `undefined` when it isn't one SES
 * writes (the test message the console sends, raw text). A `Permanent`
 * bounce is a hard bounce; `Transient` and `Undetermined` are soft ones
 * (counted, not suppressed at once). Other types (Send, Open, Click…)
 * give no events.
 */
export function sesEvents(message: string): MailEvent[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return undefined;
  }
  const parsed = sesMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const ses = parsed.data;
  const type = ses.notificationType ?? ses.eventType;
  if (!type) {
    return undefined;
  }
  const at = (own?: string) =>
    own ?? ses.mail?.timestamp ?? new Date().toISOString();
  switch (type) {
    case 'Bounce': {
      const bounce = ses.bounce;
      if (!bounce) return [];
      const kind: MailEvent['type'] =
        bounce.bounceType === 'Permanent' ? 'hard_bounce' : 'soft_bounce';
      return bounce.bouncedRecipients.map((recipient) => ({
        type: kind,
        address: recipient.emailAddress,
        occurredAt: at(bounce.timestamp),
        detail: detail(
          `${bounce.bounceType}/${bounce.bounceSubType ?? 'Unknown'}`,
          recipient.status,
          recipient.diagnosticCode,
        ),
      }));
    }
    case 'Complaint': {
      const complaint = ses.complaint;
      if (!complaint) return [];
      return complaint.complainedRecipients.map((recipient) => ({
        type: 'complaint',
        address: recipient.emailAddress,
        occurredAt: at(complaint.timestamp),
        detail: detail(complaint.complaintFeedbackType),
      }));
    }
    case 'Delivery': {
      const delivery = ses.delivery;
      if (!delivery) return [];
      return delivery.recipients.map((address) => ({
        type: 'delivery',
        address,
        occurredAt: at(delivery.timestamp),
      }));
    }
    default:
      return [];
  }
}
