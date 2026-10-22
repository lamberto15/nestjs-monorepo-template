import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../../platform.env.js';
import { MailEventIntakeRegistry } from '../mail-events.service.js';
import { ResendIntake } from './resend-intake.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const SECRET = `whsec_${KEY.toString('base64')}`;

function intake(secret: string | null = SECRET) {
  const registry = new MailEventIntakeRegistry();
  const config = {
    get: (name: keyof PlatformEnv) =>
      name === 'RESEND_WEBHOOK_SECRET' ? (secret ?? undefined) : undefined,
  } as unknown as ConfigService<PlatformEnv, true>;
  return { intake: new ResendIntake(config, registry), registry };
}

/** Signs as Svix does: HMAC-SHA256 of `id.timestamp.body`, base64, `v1,` prefixed. */
function signed(
  event: unknown,
  { at = Date.now() / 1000, key = KEY, id = 'msg_1' } = {},
) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(at));
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest('base64');
  return {
    rawBody,
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  };
}

const event = (type: string, data: object = {}) => ({
  type,
  created_at: '2026-10-21T09:00:00.000Z',
  data: { email_id: 'e1', to: ['Jane <jane@example.com>'], ...data },
});

describe('ResendIntake', () => {
  it('registers itself as "resend"', () => {
    const { registry, intake: i } = intake();
    expect(registry.find('resend')).toBe(i);
  });

  it('maps a permanent bounce to a hard bounce, with the address unwrapped', async () => {
    const result = await intake().intake.receive(
      signed(
        event('email.bounced', {
          bounce: { type: 'Permanent', subType: 'General', message: '550' },
        }),
      ),
    );
    expect(result).toEqual({
      kind: 'events',
      id: 'msg_1',
      events: [
        {
          type: 'hard_bounce',
          address: 'jane@example.com',
          occurredAt: '2026-10-21T09:00:00.000Z',
          detail: 'Permanent: General: 550',
        },
      ],
    });
  });

  it('unwraps each recipient as before: the first <…> that holds something', async () => {
    const recipients: [to: string, address: string][] = [
      ['Jane <jane@example.com>', 'jane@example.com'],
      ['jane@example.com', 'jane@example.com'],
      ['"A <b>" <jane@example.com>', 'b'],
      ['<> <jane@example.com>', 'jane@example.com'],
      ['<<jane@example.com>', '<jane@example.com'],
      ['Jane <jane@example.com', 'Jane <jane@example.com'],
      ['<>', '<>'],
      ['<', '<'],
    ];
    const result = await intake().intake.receive(
      signed(event('email.delivered', { to: recipients.map(([to]) => to) })),
    );
    if (result.kind !== 'events') throw new Error('expected events');
    expect(result.events.map((e) => e.address)).toEqual(
      recipients.map(([, address]) => address),
    );
  });

  it('unwraps a crafted recipient in linear time', async () => {
    // The pattern it replaced (/<([^>]+)>/) took about a second here.
    const to = '<'.repeat(50_000);
    const started = performance.now();
    const result = await intake().intake.receive(
      signed(event('email.delivered', { to: [to] })),
    );
    expect(performance.now() - started).toBeLessThan(250);
    if (result.kind !== 'events') throw new Error('expected events');
    expect(result.events[0]?.address).toBe(to);
  });

  it.each(['Transient', 'Undetermined'])(
    'maps a %s bounce to a soft one',
    async (type) => {
      const result = await intake().intake.receive(
        signed(event('email.bounced', { bounce: { type } })),
      );
      if (result.kind !== 'events') throw new Error('expected events');
      expect(result.events[0]?.type).toBe('soft_bounce');
    },
  );

  it('maps a complaint and a delivery', async () => {
    const complaint = await intake().intake.receive(
      signed(event('email.complained')),
    );
    const delivery = await intake().intake.receive(
      signed(event('email.delivered')),
    );
    if (complaint.kind !== 'events' || delivery.kind !== 'events') {
      throw new Error('expected events');
    }
    expect(complaint.events[0]?.type).toBe('complaint');
    expect(delivery.events[0]?.type).toBe('delivery');
  });

  it('ignores events that say nothing about the mailbox', async () => {
    expect(
      await intake().intake.receive(signed(event('email.opened'))),
    ).toEqual({ kind: 'ignored', detail: 'event-email.opened' });
  });

  it('accepts any of several signatures (a secret being rotated)', async () => {
    const good = signed(event('email.complained'));
    good.headers['svix-signature'] =
      `v1,AAAA ${good.headers['svix-signature']}`;
    expect((await intake().intake.receive(good)).kind).toBe('events');
  });

  it('refuses everything while no secret is set (403)', async () => {
    await expect(
      intake(null).intake.receive(signed(event('email.bounced'))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses missing headers (401)', async () => {
    await expect(
      intake().intake.receive({
        rawBody: Buffer.from('{}'),
        headers: {},
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a signature made with another secret, or over another body (401)', async () => {
    await expect(
      intake().intake.receive(
        signed(event('email.bounced'), { key: Buffer.alloc(32, 1) }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const tampered = signed(event('email.bounced'));
    await expect(
      intake().intake.receive({
        ...tampered,
        rawBody: Buffer.from('{"type":"email.complained","data":{}}'),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a stale or future timestamp (400)', async () => {
    const now = Date.now() / 1000;
    for (const at of [now - 600, now + 600]) {
      await expect(
        intake().intake.receive(signed(event('email.bounced'), { at })),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('refuses a signed body that is not an event (400)', async () => {
    await expect(
      intake().intake.receive(signed({ nope: true })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
