import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PlatformEnv } from '../../platform.env.js';
import { MailEventIntakeRegistry } from '../mail-events.service.js';
import { PostmarkIntake } from './postmark-intake.js';

const SECRET = 'pm-secret-0123456789';

function intake(secret: string | null = SECRET) {
  const registry = new MailEventIntakeRegistry();
  const config = {
    get: (key: keyof PlatformEnv) =>
      key === 'POSTMARK_WEBHOOK_SECRET' ? (secret ?? undefined) : undefined,
  } as unknown as ConfigService<PlatformEnv, true>;
  return { intake: new PostmarkIntake(config, registry), registry };
}

const request = (
  body: unknown,
  headers: Record<string, string> = { 'x-postmark-webhook-secret': SECRET },
) => ({ rawBody: Buffer.from(JSON.stringify(body)), headers });

const bounce = (Type: string, extra: object = {}) => ({
  RecordType: 'Bounce',
  ID: 4323372036854,
  Type,
  Email: 'Jane@Example.com',
  BouncedAt: '2026-10-16T08:00:00.1234567-05:00',
  Details: 'smtp; 550 5.1.1 user unknown',
  ...extra,
});

describe('PostmarkIntake', () => {
  it('registers itself as "postmark"', () => {
    const { registry, intake: i } = intake();
    expect(registry.find('postmark')).toBe(i);
  });

  it.each([
    ['HardBounce', 'hard_bounce'],
    ['BadEmailAddress', 'hard_bounce'],
    ['Transient', 'soft_bounce'],
    ['SoftBounce', 'soft_bounce'],
    ['SpamNotification', 'complaint'],
  ])('maps a %s bounce to %s', async (Type, type) => {
    const result = await intake().intake.receive(request(bounce(Type)));
    if (result.kind !== 'events') throw new Error('expected events');
    expect(result.id).toMatch(/^bounce-/);
    expect(result.events).toEqual([
      {
        type,
        address: 'Jane@Example.com',
        occurredAt: '2026-10-16T13:00:00.123Z',
        detail: `${Type}: smtp; 550 5.1.1 user unknown`,
      },
    ]);
  });

  it('maps a spam complaint and a delivery', async () => {
    const { intake: i } = intake();
    const complaint = await i.receive(
      request({
        RecordType: 'SpamComplaint',
        ID: 7,
        Email: 'a@example.com',
        BouncedAt: '2026-10-16T08:00:00Z',
      }),
    );
    expect(complaint).toMatchObject({
      kind: 'events',
      id: 'complaint-7',
      events: [{ type: 'complaint', address: 'a@example.com' }],
    });
    const delivery = await i.receive(
      request({
        RecordType: 'Delivery',
        MessageID: 'abc',
        Recipient: 'b@example.com',
        DeliveredAt: '2026-10-16T08:00:00Z',
      }),
    );
    expect(delivery).toMatchObject({
      kind: 'events',
      id: 'delivery-abc',
      events: [{ type: 'delivery', address: 'b@example.com' }],
    });
  });

  it('ignores bounce types that say nothing about the mailbox, and other records', async () => {
    const { intake: i } = intake();
    for (const Type of ['AutoResponder', 'Unsubscribe', 'AddressChange']) {
      await expect(i.receive(request(bounce(Type)))).resolves.toMatchObject({
        kind: 'ignored',
      });
    }
    await expect(
      i.receive(request({ RecordType: 'Open', MessageID: 'x' })),
    ).resolves.toEqual({ kind: 'ignored', detail: 'record-Open' });
  });

  it('accepts the secret as the Basic Auth password, whatever the user name', async () => {
    const basic = Buffer.from(`anyone:${SECRET}`).toString('base64');
    await expect(
      intake().intake.receive(
        request(bounce('HardBounce'), { authorization: `Basic ${basic}` }),
      ),
    ).resolves.toMatchObject({ kind: 'events' });
    // Any case, any whitespace before the credentials.
    await expect(
      intake().intake.receive(
        request(bounce('HardBounce'), { authorization: `basic \t ${basic}` }),
      ),
    ).resolves.toMatchObject({ kind: 'events' });
  });

  it('refuses a missing or wrong secret (401), before reading the body', async () => {
    const { intake: i } = intake();
    for (const headers of [
      {},
      { 'x-postmark-webhook-secret': 'nope' },
      { authorization: `Basic ${Buffer.from('u:nope').toString('base64')}` },
      { authorization: 'Bearer abc' },
      { authorization: 'Basic' },
      { authorization: 'Basic   ' },
    ]) {
      await expect(
        i.receive({ rawBody: Buffer.from('not json'), headers }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('reads a crafted Authorization header in linear time', async () => {
    // The pattern it replaced (/^Basic\s+(.+)$/i) took about a second here.
    const authorization = `Basic${'\t'.repeat(50_000)}\n`;
    const started = performance.now();
    await expect(
      intake().intake.receive({
        rawBody: Buffer.from('not json'),
        headers: { authorization },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('refuses everything (403) while no secret is configured', async () => {
    await expect(
      intake(null).intake.receive(request(bounce('HardBounce'))),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a body that is not Postmark’s (400)', async () => {
    const { intake: i } = intake();
    await expect(
      i.receive({
        rawBody: Buffer.from('<xml/>'),
        headers: { 'x-postmark-webhook-secret': SECRET },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      i.receive(request({ RecordType: 'Bounce', Type: 'HardBounce' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores an unreadable date instead of throwing', async () => {
    await expect(
      intake().intake.receive(
        request(bounce('HardBounce', { BouncedAt: 'yesterday' })),
      ),
    ).resolves.toMatchObject({ kind: 'ignored' });
  });
});
