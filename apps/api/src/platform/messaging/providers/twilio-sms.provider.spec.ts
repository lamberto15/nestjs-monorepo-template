import { createHmac } from 'node:crypto';
import { HttpClient } from '@nestjs/http-client';
import { InboundSignatureError, SmsSendError } from './sms-provider.js';
import { TwilioSmsProvider } from './twilio-sms.provider.js';

const options = {
  accountSid: 'ACtest',
  authToken: 'secret-token',
  from: '+15005550006',
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
    const provider = new TwilioSmsProvider(options, new HttpClient());

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
    const input = { to: '+4915112345678', body: 'hi', idempotencyKey: 'k' };
    /** A client like the platform's (messagingClients()), over a stubbed fetch. */
    const client = (
      answer: (request: Request) => Response | Promise<Response>,
      requests: Request[] = [],
    ) =>
      new HttpClient({
        baseUrl: 'https://twilio.test',
        retry: {
          attempts: 2,
          methods: ['POST'],
          statusCodes: [429],
          backoff: { delay: 1 },
        },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          requests.push(request.clone());
          return answer(request);
        },
      });
    const respond = (status: number, json: unknown) =>
      new TwilioSmsProvider(
        options,
        client(() => Response.json(json, { status })),
      );

    it('posts the message with the account credentials', async () => {
      const requests: Request[] = [];
      const provider = new TwilioSmsProvider(
        options,
        client(() => Response.json({ sid: 'SM9' }, { status: 201 }), requests),
      );
      await expect(
        provider.send({ ...input, idempotencyKey: 'k1' }),
      ).resolves.toEqual({ id: 'SM9' });
      const [request] = requests;
      expect(request!.url).toBe(
        'https://twilio.test/2010-04-01/Accounts/ACtest/Messages.json',
      );
      const form = new URLSearchParams(await request!.text());
      expect(form.get('To')).toBe('+4915112345678');
      expect(form.get('From')).toBe('+15005550006');
      expect(request!.headers.get('authorization')).toBe(
        `Basic ${Buffer.from('ACtest:secret-token').toString('base64')}`,
      );
      expect(request!.headers.get('i-twilio-idempotency-token')).toBe('k1');
    });

    it('sends a Messaging Service SID as such', async () => {
      const requests: Request[] = [];
      const provider = new TwilioSmsProvider(
        { ...options, from: 'MGabc' },
        client(() => Response.json({ sid: 'SM1' }, { status: 201 }), requests),
      );
      await provider.send(input);
      const form = new URLSearchParams(await requests[0]!.text());
      expect(form.get('MessagingServiceSid')).toBe('MGabc');
      expect(form.has('From')).toBe(false);
    });

    it('treats 5xx and 429 as transient, other 4xx as permanent, 21610 as an opt-out', async () => {
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

    it('retries a 429 (not taken) once, but never a 503 (the queue decides)', async () => {
      const limited: Request[] = [];
      let first = true;
      const provider = new TwilioSmsProvider(
        options,
        client(() => {
          const wasFirst = first;
          first = false;
          return wasFirst
            ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
            : Response.json({ sid: 'SM2' }, { status: 201 });
        }, limited),
      );
      await expect(provider.send(input)).resolves.toEqual({ id: 'SM2' });
      expect(limited).toHaveLength(2);

      const unavailable: Request[] = [];
      await expect(
        new TwilioSmsProvider(
          options,
          client(() => new Response('', { status: 503 }), unavailable),
        ).send(input),
      ).rejects.toMatchObject({ permanent: false });
      expect(unavailable).toHaveLength(1);
    });

    it('reports a network failure as transient', async () => {
      const provider = new TwilioSmsProvider(
        options,
        client(() => {
          throw new TypeError('fetch failed');
        }),
      );
      await expect(provider.send(input)).rejects.toMatchObject({
        permanent: false,
        message: expect.stringContaining('Twilio unreachable'),
      });
    });
  });
});
