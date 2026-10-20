import { createHmac } from 'node:crypto';
import { InboundSignatureError, SmsSendError } from './sms-provider.js';
import { TwilioSmsProvider } from './twilio-sms.provider.js';

const options = {
  accountSid: 'ACtest',
  authToken: 'secret-token',
  from: '+15005550006',
  apiUrl: 'https://twilio.test',
  webhookUrl: 'https://app.test/v1/webhooks/sms/twilio',
};

/** Twilio's documented scheme, written out independently of the adapter. */
const sign = (
  url: string,
  fields: Record<string, string>,
  token = options.authToken,
) =>
  createHmac('sha1', token)
    .update(
      url +
        Object.keys(fields)
          .sort()
          .map((key) => key + fields[key])
          .join(''),
    )
    .digest('base64');

const body = (fields: Record<string, string>) =>
  Buffer.from(new URLSearchParams(fields).toString());

describe('TwilioSmsProvider', () => {
  describe('inbound', () => {
    const fields = {
      From: '+4915112345678',
      Body: 'STOP',
      MessageSid: 'SM1',
      To: '+15005550006',
    };
    const provider = new TwilioSmsProvider(options);

    it('reads a signed message', () => {
      expect(
        provider.parseInbound({
          rawBody: body(fields),
          headers: { 'x-twilio-signature': sign(options.webhookUrl, fields) },
        }),
      ).toEqual({ from: '+4915112345678', body: 'STOP', id: 'SM1' });
    });

    it.each([
      ['no signature', undefined],
      [
        'a signature of another token',
        sign(options.webhookUrl, fields, 'other'),
      ],
      ['a signature of another URL', sign('https://evil.test/x', fields)],
      ['garbage', 'AAAA'],
    ])('refuses %s', (_name, signature) => {
      expect(() =>
        provider.parseInbound({
          rawBody: body(fields),
          headers: { 'x-twilio-signature': signature },
        }),
      ).toThrow(InboundSignatureError);
    });

    it('refuses a body changed after it was signed', () => {
      const signature = sign(options.webhookUrl, fields);
      expect(() =>
        provider.parseInbound({
          rawBody: body({ ...fields, Body: 'START' }),
          headers: { 'x-twilio-signature': signature },
        }),
      ).toThrow(InboundSignatureError);
    });
  });

  describe('send', () => {
    const respond = (status: number, json: unknown) =>
      new TwilioSmsProvider(options, (async () =>
        Response.json(json, { status })) as typeof fetch);

    it('posts the message with the account credentials', async () => {
      let seen: { url: string; init: RequestInit } | undefined;
      const provider = new TwilioSmsProvider(options, (async (
        url: string,
        init: RequestInit,
      ) => {
        seen = { url, init };
        return Response.json({ sid: 'SM9' }, { status: 201 });
      }) as unknown as typeof fetch);
      await expect(
        provider.send({
          to: '+4915112345678',
          body: 'hi',
          idempotencyKey: 'k1',
        }),
      ).resolves.toEqual({ id: 'SM9' });
      expect(seen!.url).toBe(
        'https://twilio.test/2010-04-01/Accounts/ACtest/Messages.json',
      );
      const form = seen!.init.body as URLSearchParams;
      expect(form.get('To')).toBe('+4915112345678');
      expect(form.get('From')).toBe('+15005550006');
      expect((seen!.init.headers as Record<string, string>).authorization).toBe(
        `Basic ${Buffer.from('ACtest:secret-token').toString('base64')}`,
      );
    });

    it('sends a Messaging Service SID as such', async () => {
      let form: URLSearchParams | undefined;
      const provider = new TwilioSmsProvider(
        { ...options, from: 'MGabc' },
        (async (_url: string, init: RequestInit) => {
          form = init.body as URLSearchParams;
          return Response.json({ sid: 'SM1' }, { status: 201 });
        }) as unknown as typeof fetch,
      );
      await provider.send({
        to: '+4915112345678',
        body: 'hi',
        idempotencyKey: 'k',
      });
      expect(form!.get('MessagingServiceSid')).toBe('MGabc');
      expect(form!.has('From')).toBe(false);
    });

    it('treats 5xx and 429 as transient, other 4xx as permanent, 21610 as an opt-out', async () => {
      const input = { to: '+4915112345678', body: 'hi', idempotencyKey: 'k' };
      await expect(respond(503, {}).send(input)).rejects.toMatchObject({
        permanent: false,
      });
      await expect(respond(429, {}).send(input)).rejects.toMatchObject({
        permanent: false,
      });
      await expect(
        respond(400, { code: 21211 }).send(input),
      ).rejects.toMatchObject({ permanent: true, optedOut: false });
      await expect(
        respond(400, { code: 21610 }).send(input),
      ).rejects.toMatchObject({ permanent: true, optedOut: true });
      await expect(respond(400, {}).send(input)).rejects.toBeInstanceOf(
        SmsSendError,
      );
    });
  });
});
