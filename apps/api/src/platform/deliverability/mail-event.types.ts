import type { IncomingHttpHeaders } from 'node:http';

/** The queue the verified notifications are processed on (MailEventsProcessor). */
export const MAIL_EVENTS = 'mail-events';

/** What a provider tells about one recipient of one mail. */
export interface MailEvent {
  /**
   * `hard_bounce`: the mailbox doesn't exist (SES "Permanent");
   * `soft_bounce`: it refused this one (full, greylisted, "Transient" or
   * "Undetermined"); `complaint`: the person marked the mail as spam;
   * `delivery`: it was accepted (resets the soft-bounce count).
   */
  type: 'hard_bounce' | 'soft_bounce' | 'complaint' | 'delivery';
  /** The recipient, as the provider reports it (normalized by the processor). */
  address: string;
  /** When it happened (ISO 8601), as the provider says. */
  occurredAt: string;
  /** The provider's word on it (a bounce sub-type, a diagnostic code), for the trail. */
  detail?: string;
}

/** The request an intake authenticates: the bytes as received, and the headers. */
export interface IntakeRequest {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
}

/** What an intake made of a request. */
export type IntakeResult =
  /** Events to process (queued; `id` is the provider's id for the notification, the replay key). */
  | { kind: 'events'; id: string; events: MailEvent[] }
  /** The provider's handshake was answered (an SNS subscription confirmed). */
  | { kind: 'handshake'; detail: string }
  /** Authentic, but nothing to do (a delivery notice with no recipients, a message type that is ignored). */
  | { kind: 'ignored'; detail: string };

/** What a queued job carries: provider-independent, so the processor knows no provider. */
export interface MailEventsJob {
  provider: string;
  id: string;
  events: MailEvent[];
}

/**
 * One provider's way of reporting bounces and complaints (docs/deliverability.md,
 * "Other providers"): Amazon SES through SNS today (`SesIntake`); Postmark,
 * SendGrid or another would be a class of its own with this shape,
 * registered into `MailEventIntakeRegistry`, reached at
 * `POST /webhooks/mail/<name>`. `receive()` authenticates the request
 * (throwing Nest's exceptions: 401 for a bad signature, 403 for a source
 * that isn't allowed, 400 for a malformed body), answers the provider's
 * handshake when it has one, and turns the notification into events. It
 * never touches the database: the queue does, on a worker.
 */
export interface MailEventIntake {
  /** The path segment: `ses`. */
  readonly name: string;
  receive(request: IntakeRequest): Promise<IntakeResult>;
}
