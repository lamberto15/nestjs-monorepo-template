import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  InboundSignatureError,
  type InboundSms,
  type OutgoingSms,
  SmsSendError,
  type SmsProvider,
} from './sms-provider.js';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** The sending number (E.164) or a Messaging Service SID (`MG…`). */
  from: string;
  /** Twilio's REST API. */
  apiUrl: string;
  /** The exact URL Twilio posts inbound messages to: part of what it signs. */
  webhookUrl: string;
}

/**
 * Twilio SMS. Sending is one REST call (`Messages.json`) and the inbound
 * signature is an HMAC-SHA1 of the URL and the sorted form fields, both
 * written here with `fetch` and node:crypto rather than the `twilio` SDK:
 * that SDK would add dozens of dependencies for these two calls (as
 * deliverability's SendGrid intake does for its signature).
 *
 * STOP, START and HELP are answered by Twilio itself for the sending number
 * (the carrier-level suppression: Twilio then refuses to send to an opted-out
 * number, error 21610); the webhook only tells the app, which records the
 * opt-out so it stops queueing messages and shows it to the user.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';

  constructor(
    private readonly options: TwilioOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(message: OutgoingSms) {
    const { accountSid, authToken, from, apiUrl } = this.options;
    const form = new URLSearchParams({ To: message.to, Body: message.body });
    form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
    let response: Response;
    try {
      response = await this.fetcher(
        `${apiUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            'i-twilio-idempotency-token': message.idempotencyKey,
          },
          body: form,
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      throw new SmsSendError(
        `Twilio unreachable: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    if (response.ok) {
      const body = (await response.json()) as { sid?: string };
      return { id: body.sid ?? '' };
    }
    const body = (await response.json().catch(() => ({}))) as {
      code?: number;
      message?: string;
    };
    const transient = response.status === 429 || response.status >= 500;
    throw new SmsSendError(
      `Twilio refused (${response.status}${body.code ? `, code ${body.code}` : ''})`,
      !transient,
      body.code === 21610,
    );
  }

  parseInbound({
    rawBody,
    headers,
  }: Parameters<SmsProvider['parseInbound']>[0]): InboundSms {
    const signature = headers['x-twilio-signature'];
    if (typeof signature !== 'string' || !signature) {
      throw new InboundSignatureError('No signature.');
    }
    const params = new URLSearchParams(rawBody.toString('utf8'));
    // URL + each field's name and value, fields sorted by name (Twilio's scheme).
    const signed = [...params.keys()]
      .filter((key, index, keys) => keys.indexOf(key) === index)
      .sort()
      .reduce(
        (text, key) => text + key + params.getAll(key).join(''),
        this.options.webhookUrl,
      );
    const expected = createHmac('sha1', this.options.authToken)
      .update(signed, 'utf8')
      .digest();
    const given = Buffer.from(signature, 'base64');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new InboundSignatureError('The signature does not verify.');
    }
    return {
      from: params.get('From') ?? '',
      body: params.get('Body') ?? '',
      id: params.get('MessageSid') ?? '',
    };
  }
}
