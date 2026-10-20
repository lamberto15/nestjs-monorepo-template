import { createHmac, randomBytes } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { OutboxRelay } from '@nestjs/outbox';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type request from 'supertest';
import { EncryptionService } from '../src/core/encryption/encryption.service.js';
import { auditLog } from '../src/iam/iam.tables.js';
import type { MessagingResult } from '../src/platform/messaging/messaging.processor.js';
import { MESSAGING } from '../src/platform/messaging/messaging.queue.js';
import { MemoryPushProvider } from '../src/platform/messaging/providers/memory-push.provider.js';
import { PUSH_PROVIDER } from '../src/platform/messaging/providers/push-provider.js';
import {
  devices,
  messagingUsage,
  phoneNumbers,
} from '../src/platform/messaging/messaging.tables.js';
import { MessagingRetentionJob } from '../src/platform/messaging/messaging.retention.job.js';
import { bootApp, type TestApp } from './support.js';

/**
 * A stand-in for Twilio's REST API on loopback, started before AppModule
 * loads (TWILIO_API_URL): it records each message the worker sends and
 * answers as `state.next` says.
 */
const twilio = await vi.hoisted(async () => {
  const { createServer } = await import('node:http');
  const state = {
    next: [] as number[],
    bodies: [] as Record<string, string>[],
    auth: [] as string[],
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.bodies.push(
        Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString()),
        ),
      );
      state.auth.push(String(req.headers.authorization));
      const status = state.next.shift() ?? 201;
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            status === 201
              ? { sid: `SM${state.bodies.length}` }
              : { code: status === 400 ? 21610 : 0 },
          ),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const authToken = 'twilio-test-token';
  Object.assign(process.env, {
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_FROM: '+15005550006',
    TWILIO_API_URL: `http://127.0.0.1:${port}`,
    PUSH_PROVIDER: 'memory',
    SMS_ALLOWED_PREFIXES: '+49,+44',
    SMS_DAILY_LIMIT_PER_TENANT: '6',
    SMS_DAILY_LIMIT_PER_PREFIX: '4',
    SMS_DAILY_LIMIT_PER_USER: '3',
    SMS_MAX_LENGTH: '60',
    PUSH_MAX_PAYLOAD_BYTES: '400',
  });
  return {
    state,
    authToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
});

const WEBHOOK_URL = 'http://127.0.0.1/v1/webhooks/sms/twilio';
const NUMBER = '+4915112345678';

describe('push and SMS (e2e)', () => {
  let node: TestApp;
  const db = () => node.db;

  beforeEach(async () => {
    twilio.state.bodies.length = 0;
    twilio.state.auth.length = 0;
    twilio.state.next.length = 0;
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });
  afterAll(() => twilio.close());

  const queue = () => node.app.get<Queue>(getQueueToken(MESSAGING));
  const push = () => node.app.get<MemoryPushProvider>(PUSH_PROVIDER);

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** The workers run in the tests (the queue is live): waits until no job is waiting, running or due again. */
  async function idle() {
    for (let tries = 0; tries < 400; tries++) {
      const counts = await queue().getJobCounts(
        'waiting',
        'active',
        'delayed',
        'prioritized',
      );
      if (Object.values(counts).every((count) => count === 0)) return;
      await sleep(25);
    }
    throw new Error('The messaging queue did not go idle.');
  }

  /** Every job of the queue once it is idle, finished or not. */
  async function jobs() {
    await idle();
    return queue().getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
  }

  /** What the worker did with each job since the last call, oldest first; clears them. */
  async function work(): Promise<MessagingResult[]> {
    const all = (await jobs()).sort(
      (a, b) => (a.processedOn ?? a.timestamp) - (b.processedOn ?? b.timestamp),
    );
    const results: MessagingResult[] = [];
    for (const job of all) {
      results.push(
        (await job.getState()) === 'failed'
          ? { status: 'blocked', reason: `failed: ${job.failedReason}` }
          : (job.returnvalue as MessagingResult),
      );
    }
    await Promise.all(all.map((job) => job.remove()));
    return results;
  }

  const code = () => {
    const text = twilio.state.bodies.at(-1)?.Body ?? '';
    return /code is (\d{6})/.exec(text)?.[1];
  };

  /** A user whose number is set and verified (the code texted to it, read from the stub). */
  async function userWithPhone(phone = NUMBER) {
    const user = await node.user(['editor']);
    await user.agent.put('/v1/messaging/phone').send({ phone }).expect(200);
    await work();
    await user.agent
      .post('/v1/messaging/phone/verify')
      .send({ code: code() })
      .expect(200);
    return user;
  }

  /** Tells the user (the owner of an item the administrator comments on) through their channels. */
  async function notifyOwner(agent: request.Agent) {
    const item = (
      await node.writeItem(agent, { title: 'Hello', body: '' }).expect(201)
    ).body as { id: string };
    await node
      .admin()
      .post(`/v1/test-items/${item.id}/comments`)
      .send({ body: 'Looks good.' })
      .expect(201);
    await node.app.get(OutboxRelay).runOnce();
  }

  const enable = (agent: request.Agent, channels: Record<string, boolean>) =>
    agent
      .put('/v1/notifications/preferences')
      .send({ 'testItem.commented': channels })
      .expect(200);

  describe('devices', () => {
    const subscription = JSON.stringify({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
    });

    it('registers, refreshes and removes a device; the token is encrypted and never returned', async () => {
      const user = await node.user(['editor']);
      const registered = await user.agent
        .put('/v1/devices')
        .send({ platform: 'web', name: 'Firefox', token: subscription })
        .expect(200);
      expect(registered.body).toEqual({
        id: expect.any(String),
        platform: 'web',
        name: 'Firefox',
        lastSeenAt: expect.any(String),
        createdAt: expect.any(String),
      });
      expect(JSON.stringify(registered.body)).not.toContain('push.example');

      // Stored sealed, with a blind index to find it again.
      const [row] = await db()
        .select()
        .from(devices)
        .where(eq(devices.id, registered.body.id));
      expect(row!.token).toMatch(/^v1\./);
      expect(row!.token).not.toContain('push.example');
      expect(row!.tokenIndex).toBeTruthy();

      // The app opening again: the same device, a new name.
      const again = await user.agent
        .put('/v1/devices')
        .send({ platform: 'web', name: 'Firefox 2', token: subscription })
        .expect(200);
      expect(again.body.id).toBe(registered.body.id);
      const list = await user.agent.get('/v1/devices').expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].name).toBe('Firefox 2');

      // Another person cannot see or remove it.
      const other = await node.user(['editor']);
      expect(
        (await other.agent.get('/v1/devices').expect(200)).body.items,
      ).toEqual([]);
      await other.agent.delete(`/v1/devices/${registered.body.id}`).expect(404);

      await user.agent.delete(`/v1/devices/${registered.body.id}`).expect(204);
      expect(
        (await user.agent.get('/v1/devices').expect(200)).body.items,
      ).toEqual([]);
      expect(
        await db()
          .select()
          .from(devices)
          .where(eq(devices.id, registered.body.id)),
      ).toEqual([]);
      const actions = (await db().select().from(auditLog)).map(
        (entry) => entry.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining(['device.registered', 'device.removed']),
      );
    });

    it('moves a token another person registered to the caller', async () => {
      const first = await node.user(['editor']);
      const second = await node.user(['editor']);
      const body = {
        platform: 'web',
        name: 'Shared browser',
        token: subscription,
      };
      await first.agent.put('/v1/devices').send(body).expect(200);
      await second.agent.put('/v1/devices').send(body).expect(200);
      expect(
        (await first.agent.get('/v1/devices').expect(200)).body.items,
      ).toEqual([]);
      expect(
        (await second.agent.get('/v1/devices').expect(200)).body.items,
      ).toHaveLength(1);
    });

    it('validates the body, and is a person’s own', async () => {
      const user = await node.user(['editor']);
      await user.agent
        .put('/v1/devices')
        .send({ platform: 'fridge', name: 'x', token: 't' })
        .expect(400);
      await user.agent
        .put('/v1/devices')
        .send({ platform: 'web', name: '', token: 't' })
        .expect(400);
      const client = await node.client();
      await node
        .http()
        .get('/v1/devices')
        .set('Authorization', client.auth)
        .expect(403);
      await node.http().get('/v1/devices').expect(401);
    });

    it('is erased with the account and swept when stale', async () => {
      const user = await node.user(['editor']);
      const device = (
        await user.agent
          .put('/v1/devices')
          .send({ platform: 'web', name: 'Old', token: subscription })
          .expect(200)
      ).body;
      await db()
        .update(devices)
        .set({ lastSeenAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(eq(devices.id, device.id));
      const swept = await node.app.get(MessagingRetentionJob).run();
      expect(swept.devices).toBe(1);
      expect(
        await db().select().from(devices).where(eq(devices.id, device.id)),
      ).toEqual([]);
    });
  });

  describe('push delivery', () => {
    const token = (suffix: string) =>
      JSON.stringify({ endpoint: `https://push.example/${suffix}` });

    it('pushes to every device when the type is switched on, through the queue', async () => {
      const user = await node.user(['editor']);
      await user.agent
        .put('/v1/devices')
        .send({ platform: 'web', name: 'A', token: token('a') })
        .expect(200);
      await user.agent
        .put('/v1/devices')
        .send({ platform: 'ios', name: 'B', token: token('b') })
        .expect(200);
      await enable(user.agent, { push: true });

      await notifyOwner(user.agent);
      // The delivery only queues; the worker sends (one job per device).
      expect(await work()).toEqual([{ status: 'sent' }, { status: 'sent' }]);
      expect(
        push()
          .sent.map((sent) => sent.token)
          .sort(),
      ).toEqual([token('a'), token('b')].sort());
      expect(push().sent[0]!.payload).toMatchObject({
        title: 'New comment',
        link: expect.stringContaining('/test-items/'),
      });
    });

    it('sends nothing when the type is not switched on, and clips an oversized payload', async () => {
      const user = await node.user(['editor']);
      await user.agent
        .put('/v1/devices')
        .send({ platform: 'web', name: 'A', token: token('c') })
        .expect(200);
      await notifyOwner(user.agent);
      expect(await jobs()).toEqual([]);

      await enable(user.agent, { push: true });
      const item = (
        await node
          .writeItem(user.agent, { title: 'x'.repeat(100), body: '' })
          .expect(201)
      ).body as { id: string };
      await node
        .admin()
        .post(`/v1/test-items/${item.id}/comments`)
        .send({ body: 'y'.repeat(500) })
        .expect(201);
      await node.app.get(OutboxRelay).runOnce();
      await work();
      const payload = push().sent.at(-1)!.payload;
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
        400,
      );
    });

    it('deletes a device its provider reports dead', async () => {
      const user = await node.user(['editor']);
      const dead = (
        await user.agent
          .put('/v1/devices')
          .send({ platform: 'web', name: 'Gone', token: 'dead-token' })
          .expect(200)
      ).body;
      await enable(user.agent, { push: true });
      await notifyOwner(user.agent);
      expect(await work()).toEqual([
        { status: 'skipped', reason: 'device_gone' },
      ]);
      expect(
        (await user.agent.get('/v1/devices').expect(200)).body.items,
      ).toEqual([]);
      expect(
        await db().select().from(devices).where(eq(devices.id, dead.id)),
      ).toEqual([]);
    });
  });

  describe('the phone number and SMS delivery', () => {
    it('sets a number, texts a code, verifies it; the number is encrypted and shown masked', async () => {
      const user = await node.user(['editor']);
      const set = await user.agent
        .put('/v1/messaging/phone')
        .send({ phone: '+49 151 1234 5678' })
        .expect(200);
      expect(set.body).toEqual({
        phone: '+49•••••••••78',
        verified: false,
        optedOut: false,
      });
      expect(await work()).toEqual([{ status: 'sent' }]);
      expect(twilio.state.bodies.at(-1)).toMatchObject({
        To: NUMBER,
        From: '+15005550006',
      });
      expect(twilio.state.auth.at(-1)).toBe(
        `Basic ${Buffer.from(`ACtest:${twilio.authToken}`).toString('base64')}`,
      );

      const [row] = await db()
        .select()
        .from(phoneNumbers)
        .where(eq(phoneNumbers.userId, user.id));
      expect(row!.phone).toMatch(/^v1\./);
      expect(row!.phone).not.toContain('151');
      expect(
        node.app.get(EncryptionService).decrypt(phoneNumbers.phone, row!.phone),
      ).toBe(NUMBER);

      await user.agent
        .post('/v1/messaging/phone/verify')
        .send({ code: '000000' })
        .expect(400);
      const right = code()!;
      const verified = await user.agent
        .post('/v1/messaging/phone/verify')
        .send({ code: right })
        .expect(200);
      expect(verified.body.verified).toBe(true);
      // A code works once.
      await user.agent
        .post('/v1/messaging/phone/verify')
        .send({ code: right })
        .expect(400);
      expect(
        (await user.agent.get('/v1/messaging/phone').expect(200)).body.phone,
      ).toBe('+49•••••••••78');
    });

    it('voids a code after five wrong guesses', async () => {
      const user = await node.user(['editor']);
      await user.agent
        .put('/v1/messaging/phone')
        .send({ phone: NUMBER })
        .expect(200);
      await work();
      const right = code()!;
      const wrong = right === '123456' ? '654321' : '123456';
      for (let guess = 0; guess < 5; guess++) {
        await user.agent
          .post('/v1/messaging/phone/verify')
          .send({ code: wrong })
          .expect(400);
      }
      await user.agent
        .post('/v1/messaging/phone/verify')
        .send({ code: right })
        .expect(400);
    });

    it('refuses a number outside the allowed countries, and a malformed one', async () => {
      const user = await node.user(['editor']);
      const refused = await user.agent
        .put('/v1/messaging/phone')
        .send({ phone: '+33612345678' })
        .expect(400);
      expect(refused.body.code).toBe('phone_country_not_allowed');
      const bad = await user.agent
        .put('/v1/messaging/phone')
        .send({ phone: '0151 12345' })
        .expect(400);
      expect(bad.body.code).toBe('phone_invalid');
      expect(await jobs()).toEqual([]);
    });

    it('texts a notification only to a verified number, when the type is switched on', async () => {
      const user = await userWithPhone();
      twilio.state.bodies.length = 0;
      await notifyOwner(user.agent);
      expect(await jobs()).toEqual([]); // off by default

      await enable(user.agent, { sms: true });
      await notifyOwner(user.agent);
      expect(await work()).toEqual([{ status: 'sent' }]);
      expect(twilio.state.bodies).toHaveLength(1);
      expect(twilio.state.bodies[0]!.To).toBe(NUMBER);
      expect(twilio.state.bodies[0]!.Body.startsWith('New comment')).toBe(true);
      expect(twilio.state.bodies[0]!.Body.length).toBeLessThanOrEqual(60);

      // A number that is not verified gets nothing.
      const unverified = await node.user(['editor']);
      await unverified.agent
        .put('/v1/messaging/phone')
        .send({ phone: '+4915198765432' })
        .expect(200);
      await work();
      twilio.state.bodies.length = 0;
      await enable(unverified.agent, { sms: true });
      await notifyOwner(unverified.agent);
      expect(await jobs()).toEqual([]);
    });

    it('retries a transient provider failure through the queue', async () => {
      const user = await userWithPhone();
      await enable(user.agent, { sms: true });
      twilio.state.bodies.length = 0;
      twilio.state.next.push(503);
      await notifyOwner(user.agent);
      // The first attempt was refused with a 503; the queue's backoff sent it again.
      expect(await work()).toEqual([{ status: 'sent' }]);
      expect(twilio.state.bodies).toHaveLength(2);
    });
  });

  describe('toll-fraud caps', () => {
    /** Texts a notification to the user and returns the worker's verdicts. */
    async function textOnce(agent: request.Agent) {
      await notifyOwner(agent);
      return work();
    }

    it('caps a user per day, refuses past it and counts the refusal', async () => {
      const user = await userWithPhone(); // the code was the first of the user's three
      await enable(user.agent, { sms: true });
      expect(await textOnce(user.agent)).toEqual([{ status: 'sent' }]);
      expect(await textOnce(user.agent)).toEqual([{ status: 'sent' }]);
      const sentBefore = twilio.state.bodies.length;
      expect(await textOnce(user.agent)).toEqual([
        { status: 'blocked', reason: 'user_limit' },
      ]);
      expect(twilio.state.bodies).toHaveLength(sentBefore);

      const counters = await db().select().from(messagingUsage);
      const count = (counter: string) =>
        counters.find((row) => row.counter === counter)?.count;
      // The refused SMS used none of the allowance (its reservation rolled back).
      expect(count(`user:${user.id}`)).toBe(3);
      expect(count('blocked:user_limit')).toBe(1);
    });

    it('caps a tenant, and a destination prefix inside it', async () => {
      // Prefix +49: 4 a day. Tenant: 6.
      const germans = [];
      for (let i = 0; i < 2; i++)
        germans.push(await userWithPhone(`+49151100000${i}0`)); // 2 codes
      for (const user of germans) await enable(user.agent, { sms: true });
      expect(await textOnce(germans[0]!.agent)).toEqual([{ status: 'sent' }]); // 3
      expect(await textOnce(germans[1]!.agent)).toEqual([{ status: 'sent' }]); // 4
      expect(await textOnce(germans[0]!.agent)).toEqual([
        { status: 'blocked', reason: 'prefix_limit' },
      ]);

      // Another prefix still has room, until the tenant's six are used.
      const british = await userWithPhone('+447700900123'); // 5
      await enable(british.agent, { sms: true });
      expect(await textOnce(british.agent)).toEqual([{ status: 'sent' }]); // 6
      expect(await textOnce(british.agent)).toEqual([
        { status: 'blocked', reason: 'tenant_limit' },
      ]);
    });

    it('counts per tenant: another tenant has its own allowance', async () => {
      const first = await userWithPhone();
      await enable(first.agent, { sms: true });
      await textOnce(first.agent);
      const other = await node.otherTenant();
      const member = await other.user(['editor']);
      expect(member.id).toBeTruthy();
      const rows = await db()
        .select()
        .from(messagingUsage)
        .where(eq(messagingUsage.counter, 'tenant'));
      expect(rows).toHaveLength(1); // only the first tenant has used any
    });

    it('re-checks the allowlist at send time (a number stored before the list changed)', async () => {
      const user = await node.user(['editor']);
      const encryption = node.app.get(EncryptionService);
      await db()
        .insert(phoneNumbers)
        .values({
          userId: user.id,
          verifiedAt: new Date(),
          ...(encryption.seal(phoneNumbers.phone, '+33612345678') as {
            phone: string;
            phoneIndex: string;
          }),
        });
      await enable(user.agent, { sms: true });
      expect(await textOnce(user.agent)).toEqual([
        { status: 'blocked', reason: 'prefix_not_allowed' },
      ]);
      expect(twilio.state.bodies).toHaveLength(0);
    });

    it('stops all sending with the operators’ kill switch', async () => {
      const user = await userWithPhone();
      await enable(user.agent, { sms: true });
      await node
        .admin()
        .put('/v1/settings/messaging.sms/platform')
        .send({ value: false, enforced: true })
        .expect(200);
      twilio.state.bodies.length = 0;
      expect(await textOnce(user.agent)).toEqual([
        { status: 'skipped', reason: 'switched_off' },
      ]);
      expect(twilio.state.bodies).toHaveLength(0);

      await node
        .admin()
        .delete('/v1/settings/messaging.sms/platform')
        .expect(204);
      expect(await textOnce(user.agent)).toEqual([{ status: 'sent' }]);
    });
  });

  describe('STOP and START', () => {
    const sign = (fields: Record<string, string>, token = twilio.authToken) =>
      createHmac('sha1', token)
        .update(
          WEBHOOK_URL +
            Object.keys(fields)
              .sort()
              .map((key) => key + fields[key])
              .join(''),
        )
        .digest('base64');
    const inbound = (
      fields: Record<string, string>,
      signature = sign(fields),
    ) =>
      node
        .http()
        .post('/v1/webhooks/sms/twilio')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(fields);
    const message = (Body: string, From = NUMBER) => ({
      From,
      To: '+15005550006',
      Body,
      MessageSid: `SM${randomBytes(4).toString('hex')}`,
    });

    it('refuses what is not signed by the provider', async () => {
      const user = await userWithPhone();
      const fields = message('STOP');
      expect(
        (await inbound(fields, 'bm90IGEgc2lnbmF0dXJl').expect(401)).body.code,
      ).toBe('sms_signature_invalid');
      await node
        .http()
        .post('/v1/webhooks/sms/twilio')
        .type('form')
        .send(fields)
        .expect(401);
      await inbound(fields, sign(fields, 'someone-elses-token')).expect(401);
      // Not the configured provider.
      await node
        .http()
        .post('/v1/webhooks/sms/other')
        .type('form')
        .send(fields)
        .expect(404);
      expect(
        (await user.agent.get('/v1/messaging/phone').expect(200)).body.optedOut,
      ).toBe(false);
    });

    it('opts the number out on STOP: no SMS until START, which only re-enables', async () => {
      const user = await userWithPhone();
      await enable(user.agent, { sms: true });

      await inbound(message('  stop ')).expect(204);
      expect(
        (await user.agent.get('/v1/messaging/phone').expect(200)).body,
      ).toMatchObject({ verified: true, optedOut: true });
      expect(
        (
          await db()
            .select()
            .from(auditLog)
            .where(eq(auditLog.action, 'phone.optedOut'))
        ).length,
      ).toBe(1);

      // The channel queues nothing for an opted-out number, and the worker re-checks.
      twilio.state.bodies.length = 0;
      await notifyOwner(user.agent);
      expect(await jobs()).toEqual([]);

      // Nor can its verification code be requested again to get around it.
      await user.agent
        .put('/v1/messaging/phone')
        .send({ phone: NUMBER })
        .expect(200);
      expect(await work()).toEqual([
        { status: 'skipped', reason: 'no_sendable_number' },
      ]);

      await inbound(message('START')).expect(204);
      expect(
        (await user.agent.get('/v1/messaging/phone').expect(200)).body.optedOut,
      ).toBe(false);
      expect(await textOnce()).toEqual([{ status: 'sent' }]);

      async function textOnce() {
        await notifyOwner(user.agent);
        return work();
      }
    });

    it('stops a job queued before the STOP arrived', async () => {
      const user = await userWithPhone();
      await enable(user.agent, { sms: true });
      await queue().pause(); // the worker is busy: the job waits
      try {
        await notifyOwner(user.agent);
        expect(await queue().getJobs(['waiting'])).toHaveLength(1);
        await inbound(message('STOP')).expect(204);
      } finally {
        await queue().resume();
      }
      twilio.state.bodies.length = 0;
      expect(await work()).toEqual([
        { status: 'skipped', reason: 'no_sendable_number' },
      ]);
      expect(twilio.state.bodies).toHaveLength(0);
    });

    it('ignores other replies, unknown numbers, and START for a number that never opted out', async () => {
      const user = await userWithPhone();
      await inbound(message('please stop texting me')).expect(204);
      await inbound(message('HELP')).expect(204);
      await inbound(message('START')).expect(204);
      await inbound(message('STOP', '+4917600000000')).expect(204);
      await inbound(message('STOP', 'not a number')).expect(204);
      expect(
        (await user.agent.get('/v1/messaging/phone').expect(200)).body.optedOut,
      ).toBe(false);
      expect(
        await db()
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.action, 'phone.optedOut'))),
      ).toEqual([]);
    });

    it('records an opt-out the provider reports on send (error 21610)', async () => {
      const user = await userWithPhone();
      await enable(user.agent, { sms: true });
      twilio.state.next.push(400);
      await notifyOwner(user.agent);
      const results = await work();
      expect(results[0]!.status).toBe('blocked'); // the job failed for good
      expect(
        (await user.agent.get('/v1/messaging/phone').expect(200)).body.optedOut,
      ).toBe(true);
    });
  });

  describe('preferences', () => {
    it('offers sms and push per type to a user, and not to an API client', async () => {
      const user = await node.user(['editor']);
      const types = (
        await user.agent.get('/v1/notifications/types').expect(200)
      ).body.items as { channels: Record<string, unknown> }[];
      // Off unless a type's declaration turns them on.
      expect(types.length).toBeGreaterThan(0);
      const prefs = await enable(user.agent, { sms: true, push: true });
      expect(prefs.body.types['testItem.commented']).toMatchObject({
        sms: true,
        push: true,
      });
      await user.agent
        .put('/v1/notifications/preferences')
        .send({ 'testItem.commented': { sms: 'yes' } })
        .expect(400);

      const client = await node.client();
      const refused = await node
        .http()
        .put('/v1/notifications/preferences')
        .set('Authorization', client.auth)
        .send({ 'testItem.commented': { sms: true } })
        .expect(400);
      expect(refused.body.errors[0].path).toBe('testItem.commented.sms');
    });

    it('removes the number and its pending code', async () => {
      const user = await userWithPhone();
      await user.agent
        .put('/v1/devices')
        .send({ platform: 'web', name: 'A', token: 'tok' })
        .expect(200);
      const row = async () =>
        (
          await db()
            .select()
            .from(phoneNumbers)
            .where(eq(phoneNumbers.userId, user.id))
        ).length;
      expect(await row()).toBe(1);
      await user.agent.delete('/v1/messaging/phone').expect(204);
      expect(await row()).toBe(0);
    });
  });
});
