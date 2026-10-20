import { generateKeyPairSync, sign } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../../platform.env.js';
import { MailEventIntakeRegistry } from '../mail-events.service.js';
import { SendGridIntake } from './sendgrid-intake.js';

const { publicKey, privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
});
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY = publicKey
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

function intake(key: string | null = KEY) {
  const registry = new MailEventIntakeRegistry();
  const config = {
    get: (name: keyof PlatformEnv) =>
      name === 'SENDGRID_WEBHOOK_PUBLIC_KEY' ? (key ?? undefined) : undefined,
  } as unknown as ConfigService<PlatformEnv, true>;
  return { intake: new SendGridIntake(config, registry), registry };
}

/** Signs as SendGrid does: ECDSA/SHA-256 over timestamp + body, base64 DER. */
function signed(
  events: unknown,
  { at = Date.now() / 1000, key = privateKey } = {},
) {
  const rawBody = Buffer.from(JSON.stringify(events));
  const timestamp = String(Math.floor(at));
  const signature = sign(
    'sha256',
    Buffer.concat([Buffer.from(timestamp), rawBody]),
    key,
  ).toString('base64');
  return {
    rawBody,
    headers: {
      'x-twilio-email-event-webhook-signature': signature,
      'x-twilio-email-event-webhook-timestamp': timestamp,
    },
  };
}

const event = (name: string, extra: object = {}) => ({
  email: 'jane@example.com',
  timestamp: 1760601600,
  event: name,
  sg_event_id: `id-${name}`,
  ...extra,
});

describe('SendGridIntake', () => {
  it('registers itself as "sendgrid"', () => {
    const { registry, intake: i } = intake();
    expect(registry.find('sendgrid')).toBe(i);
  });

  it('maps bounce, blocked, spamreport and delivered; drops the rest', async () => {
    const result = await intake().intake.receive(
      signed([
        event('bounce', {
          type: 'bounce',
          reason: '550 unknown',
          status: '5.1.1',
        }),
        event('blocked', { reason: 'mailbox full' }),
        event('spamreport'),
        event('delivered'),
        event('dropped'),
        event('deferred'),
        event('open'),
      ]),
    );
    if (result.kind !== 'events') throw new Error('expected events');
    expect(result.events.map((e) => e.type)).toEqual([
      'hard_bounce',
      'soft_bounce',
      'complaint',
      'delivery',
    ]);
    expect(result.events[0]).toEqual({
      type: 'hard_bounce',
      address: 'jane@example.com',
      occurredAt: new Date(1760601600 * 1000).toISOString(),
      detail: '550 unknown 5.1.1',
    });
    expect(result.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores event names that are Object.prototype members', async () => {
    await expect(
      intake().intake.receive(
        signed([event('constructor'), event('toString'), event('__proto__')]),
      ),
    ).resolves.toEqual({ kind: 'ignored', detail: 'no-delivery-events' });
  });

  it('gives a redelivered request the same id', async () => {
    const { intake: i } = intake();
    const request = signed([event('bounce')]);
    const a = await i.receive(request);
    const b = await i.receive(request);
    expect(a).toMatchObject({ kind: 'events' });
    expect(b).toEqual(a);
  });

  it('ignores a batch with nothing about delivery', async () => {
    await expect(
      intake().intake.receive(signed([event('open'), event('click')])),
    ).resolves.toEqual({ kind: 'ignored', detail: 'no-delivery-events' });
  });

  it('refuses a signature from another key, or over another body (401)', async () => {
    const { intake: i } = intake();
    await expect(
      i.receive(signed([event('bounce')], { key: other.privateKey })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const tampered = signed([event('bounce')]);
    await expect(
      i.receive({
        ...tampered,
        rawBody: Buffer.from(JSON.stringify([event('delivered')])),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses missing headers (401) and a garbage key', async () => {
    await expect(
      intake().intake.receive({ rawBody: Buffer.from('[]'), headers: {} }),
    ).rejects.toMatchObject({
      response: { code: 'sendgrid_signature_missing' },
    });
    await expect(
      intake('not-a-key').intake.receive(signed([event('bounce')])),
    ).rejects.toMatchObject({
      response: { code: 'sendgrid_signature_invalid' },
    });
  });

  it('refuses a stale or future timestamp (400), even when correctly signed', async () => {
    const { intake: i } = intake();
    await expect(
      i.receive(signed([event('bounce')], { at: Date.now() / 1000 - 7200 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      i.receive(signed([event('bounce')], { at: Date.now() / 1000 + 3600 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses everything (403) while no key is configured', async () => {
    await expect(
      intake(null).intake.receive(signed([event('bounce')])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a signed body that is not an array of events (400)', async () => {
    await expect(
      intake().intake.receive(signed({ event: 'bounce' })),
    ).rejects.toMatchObject({ response: { code: 'sendgrid_malformed' } });
  });
});
