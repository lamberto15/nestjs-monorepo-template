/**
 * An SMS provider behind one interface (docs/notifications.md, "Push and
 * SMS"): the worker sends through it and the inbound webhook is verified and
 * read by it, so a project can swap Twilio for another provider without
 * touching the channel, the caps or the opt-out handling.
 */
export interface OutgoingSms {
  /** E.164. */
  to: string;
  body: string;
  /** Stable per message: a retry never sends twice where the provider supports it. */
  idempotencyKey: string;
}

export interface InboundSms {
  /** The sender's number, E.164. */
  from: string;
  body: string;
  /** The provider's id of the message (a redelivery repeats it). */
  id: string;
}

/** The provider refused or failed. `permanent`: retrying will not help. */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    /** The provider says the number opted out (Twilio 21610): record it. */
    readonly optedOut = false,
  ) {
    super(message);
  }
}

/** The inbound request failed the provider's signature check. */
export class InboundSignatureError extends Error {}

export interface SmsProvider {
  readonly name: string;
  send(message: OutgoingSms): Promise<{ id: string }>;
  /**
   * Verifies the provider's signature on an inbound message and reads it.
   * Throws InboundSignatureError when it does not verify (or the provider
   * cannot verify inbound at all).
   */
  parseInbound(request: {
    rawBody: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): InboundSms;
}

/** The DI token of the configured provider; null when SMS_PROVIDER is `off`. */
export const SMS_PROVIDER = Symbol('messaging.sms-provider');
