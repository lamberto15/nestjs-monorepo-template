import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getQueueToken } from '@nestjs/bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { Queue } from 'bullmq';
import { inArray } from 'drizzle-orm';
import { MailEvents } from '@nestjs/mail';
import { Outbox, OutboxEvents } from '@nestjs/outbox';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { ResilienceEvents } from '@nestjs/resilience';
import { WorkflowEvents } from '@nestjs/workflows';
import type { Database } from '../src/core/database/drizzle.js';
import { REDACTED } from '../src/core/logging/redaction.js';
import { inTransaction } from '../src/core/database/transactions.js';
import type { NotificationType } from '../src/platform/notifications/notification.types.js';
import { notifications } from '../src/platform/notifications/notifications.tables.js';
import { NotificationsService } from '../src/platform/notifications/notifications.service.js';
import {
  backlogPreviewSchema,
  backlogResultSchema,
  opsEventSchema,
  outboxStateSchema,
  purgedSchema,
  queueOverviewSchema,
  requeuedSchema,
  retriedSchema,
} from '../src/platform/ops/ops.schemas.js';
import { bootApp, type TestApp } from './support.js';

// Made up per run, in the shapes the redaction looks for.
const credential = () => `tok-${randomUUID().replaceAll('-', '')}`;

/**
 * The operations routes (e2e): every answer is its declared schema, and what
 * the engines hold (error messages, payloads, headers) reaches the browser
 * masked and cut, never with a stack trace.
 */
describe('operations API (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  /** A message the outbox gave up on, as a failed publish leaves it. */
  async function deadLetter(
    message: {
      payload: unknown;
      headers: Record<string, string>;
    },
    error: string,
  ) {
    const db = node.app.get<Database>(getDrizzleToken());
    const store = node.app.get(PostgresOutboxStore);
    const [added] = await db.transaction(async (tx) =>
      node.app.get(Outbox).add(tx as never, [
        {
          topic: 'ops.test',
          key: 'ops-test',
          payload: message.payload,
          headers: message.headers,
        },
      ]),
    );
    const owner = randomUUID();
    const claimed = await store.claim({
      owner,
      now: Date.now(),
      leaseMs: 60_000,
      limit: 1000,
    });
    const others = claimed.filter((m) => m.id !== added!.id).map((m) => m.id);
    if (others.length > 0) {
      await store.release(others, owner);
    }
    const moved = await store.deadLetter(added!.id, owner, {
      attempts: 5,
      reason: 'exhausted',
      failedAt: Date.now(),
      error: { attempt: 5, at: Date.now(), error, transport: 'local' },
    });
    expect(moved).toBe(true);
    return added!.id;
  }

  it('answers GET /v1/ops/outbox as its schema: stats, dead letters, notifications, canManage', async () => {
    const res = await node.admin().get('/v1/ops/outbox').expect(200);
    expect(outboxStateSchema.parse(res.body)).toEqual(res.body);
    expect(res.body).toEqual({
      stats: {
        pending: expect.any(Number),
        ready: expect.any(Number),
        leased: expect.any(Number),
        deadLetters: 0,
        oldestDueAt: expect.toBeOneOf([null, expect.any(Number)]),
        lagMs: expect.any(Number),
        inFlight: 0,
      },
      deadLetters: [],
      notifications: { undelivered: 0, undeliveredCapped: false },
      canManage: true,
    });
  });

  it('masks secrets in a dead letter, cuts a long error and sends no stack trace', async () => {
    const token = credential();
    const password = `pw-${credential()}`;
    const apiKey = credential();
    const id = await deadLetter(
      {
        payload: {
          to: 'a@example.com',
          password,
          nested: { apiKey, note: `refreshToken=${token}` },
        },
        headers: { Authorization: `Bearer ${token}`, 'x-trace': 't1' },
      },
      `Error: upstream said Authorization: Bearer ${token}\n    at send (/app/dist/mail.js:10:5)\n${'x'.repeat(5000)}`,
    );

    const res = await node.admin().get('/v1/ops/outbox').expect(200);
    expect(outboxStateSchema.parse(res.body)).toEqual(res.body);
    const [letter] = res.body.deadLetters;
    expect(letter).toMatchObject({
      id,
      topic: 'ops.test',
      key: 'ops-test',
      attempts: 5,
      reason: 'exhausted',
      payload: {
        to: 'a@example.com',
        password: REDACTED,
        nested: { apiKey: REDACTED },
      },
      headers: { Authorization: REDACTED, 'x-trace': 't1' },
    });
    expect(letter.history).toHaveLength(1);
    const text = JSON.stringify(res.body);
    for (const secret of [token, password, apiKey]) {
      expect(text).not.toContain(secret);
    }
    // No stack frames, and the long text cut (with the ellipsis).
    expect(text).not.toContain('mail.js');
    expect(letter.lastError).toMatch(/^Error: upstream said/);
    expect(letter.lastError.length).toBeLessThanOrEqual(1001);
    expect(letter.history[0].error.length).toBeLessThanOrEqual(1001);

    // The routes that act on it answer their counts.
    const requeued = await node
      .admin()
      .post('/v1/ops/dead-letters/requeue')
      .send({ ids: [id] })
      .expect(200);
    expect(requeuedSchema.parse(requeued.body)).toEqual({ requeued: 1 });
    const purged = await node
      .admin()
      .post('/v1/ops/dead-letters/purge')
      .send({ ids: [id] })
      .expect(200);
    expect(purgedSchema.parse(purged.body)).toEqual({ purged: 0 });
  });

  it('answers GET /v1/ops/queues as its schema, and retry-failed with the count', async () => {
    const res = await node.admin().get('/v1/ops/queues').expect(200);
    expect(queueOverviewSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.items.map((q: { name: string }) => q.name)).toContain(
      'mail',
    );
    const retried = await node
      .admin()
      .post('/v1/ops/queues/mail/retry-failed')
      .expect(200);
    expect(retriedSchema.parse(retried.body)).toEqual({ retried: 0 });
    await node.admin().post('/v1/ops/queues/nope/retry-failed').expect(404);
  });

  describe('backlog recovery', () => {
    /** A stored notification and its notifications.deliver message, in a tenant. */
    const tell = (to: string, type: string, tenant = node.tenantId) =>
      node.inTenant(async () => {
        const txHost = node.app.get(TransactionHost);
        const [id] = await inTransaction(txHost, (tx) =>
          node.app.get(NotificationsService).notify(tx, {
            type: type as NotificationType,
            to,
            data:
              type === 'security.passwordChanged'
                ? { via: 'change', ip: '192.0.2.10' }
                : {
                    recordId: randomUUID(),
                    commentId: randomUUID(),
                    title: 'T',
                    by: 'Ada',
                    excerpt: 'Hi',
                  },
            key: randomUUID(),
          }),
        );
        return id!;
      }, tenant);

    it('wants exactly one of a tenant and global', async () => {
      await node.admin().post('/v1/ops/backlog/preview').send({}).expect(400);
      await node
        .admin()
        .post('/v1/ops/backlog/preview')
        .send({ tenantId: node.tenantId, global: true })
        .expect(400);
    });

    it("counts, then discards one tenant's outbox backlog of a type: never a mandatory type or another tenant's, notifications kept and marked delivered, audited", async () => {
      const user = await node.user([]);
      const other = await node.otherTenant();
      const otherUser = await other.user([]);
      const mine = [
        await tell(`user:${user.id}`, 'testItem.commented'),
        await tell(`user:${user.id}`, 'testItem.commented'),
      ];
      const secure = await tell(`user:${user.id}`, 'security.passwordChanged');
      const theirs = await tell(
        `user:${otherUser.id}`,
        'testItem.commented',
        other.id,
      );

      const scope = { tenantId: node.tenantId };
      const preview = await node
        .admin()
        .post('/v1/ops/backlog/preview')
        .send(scope)
        .expect(200);
      expect(backlogPreviewSchema.parse(preview.body)).toEqual(preview.body);
      expect(preview.body.outbox.pending.groups).toEqual(
        expect.arrayContaining([
          {
            topic: 'notifications.deliver',
            type: 'testItem.commented',
            count: 2,
            mandatory: false,
          },
          {
            topic: 'notifications.deliver',
            type: 'security.passwordChanged',
            count: 1,
            mandatory: true,
          },
        ]),
      );

      const discarded = await node
        .admin()
        .post('/v1/ops/backlog/discard')
        .send({ target: 'outbox', scope, limit: 1 })
        .expect(200);
      expect(backlogResultSchema.parse(discarded.body)).toEqual({
        count: 1,
        more: true,
      });
      const rest = await node
        .admin()
        .post('/v1/ops/backlog/discard')
        .send({ target: 'outbox', scope })
        .expect(200);
      expect(rest.body).toEqual({ count: 1, more: false });

      const delivered = async (ids: string[], tenant: string) =>
        node.inTenant(
          () =>
            node.db
              .select({
                id: notifications.id,
                deliveredAt: notifications.deliveredAt,
                readAt: notifications.readAt,
              })
              .from(notifications)
              .where(inArray(notifications.id, ids)),
          tenant,
        );
      for (const row of await delivered(mine, node.tenantId)) {
        expect(row).toMatchObject({
          deliveredAt: expect.any(Date),
          readAt: null,
        });
      }
      expect(await delivered([secure], node.tenantId)).toEqual([
        expect.objectContaining({ deliveredAt: null }),
      ]);
      expect(await delivered([theirs], other.id)).toEqual([
        expect.objectContaining({ deliveredAt: null }),
      ]);
      const after = await node
        .admin()
        .post('/v1/ops/backlog/preview')
        .send({ global: true, type: 'testItem.commented' })
        .expect(200);
      expect(after.body.outbox.pending.total).toBe(1);

      const [entry] = await node.auditEntries({
        action: 'ops.backlog-discarded',
      });
      expect(entry).toMatchObject({
        targetType: 'outbox',
        details: { scope, count: 1, more: false },
      });
    });

    it("pauses the mail queue, discards one tenant's queued mail but its essential mail, and resumes", async () => {
      const queue = node.app.get<Queue>(getQueueToken('mail'));
      await node.admin().post('/v1/ops/queues/mail/pause').expect(200, {
        name: 'mail',
        paused: true,
      });
      expect(await queue.isPaused()).toBe(true);
      const job = (data: object) =>
        queue.add('NotificationMail', { to: [], cc: [], bcc: [], ...data });
      await job({ tenantId: node.tenantId });
      await job({ tenantId: node.tenantId, essential: true });
      await job({ tenantId: node.tenantId, mandatory: true });
      await job({ tenantId: randomUUID() });
      const preview = await node
        .admin()
        .post('/v1/ops/backlog/preview')
        .send({ tenantId: node.tenantId, template: 'NotificationMail' })
        .expect(200);
      expect(
        preview.body.mail.groups.reduce(
          (sum: number, group: { count: number }) => sum + group.count,
          0,
        ),
      ).toBe(3);
      const discarded = await node
        .admin()
        .post('/v1/ops/backlog/discard')
        .send({ target: 'mail', scope: { tenantId: node.tenantId } })
        .expect(200);
      expect(discarded.body).toEqual({ count: 1, more: false });
      expect(await queue.getJobCountByTypes('waiting')).toBe(3);
      await queue.drain();
      await node.admin().post('/v1/ops/queues/mail/resume').expect(200);
      expect(await queue.isPaused()).toBe(false);
      expect(
        await node.auditEntries({ action: 'queue.paused', targetId: 'mail' }),
      ).toHaveLength(1);
    });
  });

  it('streams every engine as its schema, secrets masked and no stack trace', async () => {
    const token = credential();
    const password = `pw-${credential()}`;
    const login = await node
      .http()
      .post('/v1/auth/token')
      .send({
        email: process.env.ADMIN_EMAIL!,
        password: process.env.ADMIN_PASSWORD!,
      })
      .expect(200);
    const { port } = node.app.getHttpServer().address() as AddressInfo;
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/v1/ops/events`, {
      headers: { Authorization: `Bearer ${login.body.accessToken as string}` },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // http-setup.ts's compression() never buffers this stream: each event
    // still flushes as it is written.
    expect(response.headers.get('content-encoding')).toBeNull();

    const emit = () => {
      node.app.get(OutboxEvents).emit({
        type: 'dead-lettered',
        message: {
          id: 'm1',
          topic: 'ops.test',
          payload: { password, to: 'a@example.com' },
          headers: { authorization: `Bearer ${token}` },
          key: null,
          createdAt: 1,
          availableAt: 1,
          attempts: 5,
          lastError: null,
        },
        transport: 'local',
        error: new Error(`refused: Authorization: Bearer ${token}`),
        attempt: 5,
        reason: 'exhausted',
      });
      node.app.get(MailEvents).emit({
        type: 'failed',
        messageId: 'mail-1',
        recipients: ['a@example.com'],
        subject: 'Hello',
        transport: 'memory',
        attempts: 1,
        durationMs: 3,
        error: new Error('mailbox full'),
        permanent: false,
      });
      node.app.get(ResilienceEvents).emit({
        type: 'timeout',
        policy: 'upstream',
        source: 'billing',
        timeoutMs: 500,
      });
      node.app.get(WorkflowEvents).emit({
        type: 'workflow-failed',
        id: 'w1',
        workflow: 'onboarding',
        version: 1,
        at: 5,
        error: {
          name: 'CardDeclinedError',
          message: `declined (password=${password})`,
          stack: 'CardDeclinedError: x\n    at charge (/app/dist/pay.js:1:1)',
        },
      });
    };

    // Subscribed once the headers are out; emit again until all four arrived.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const events: Record<string, any>[] = [];
    const sources = () => new Set(events.map((e) => e.source));
    const timer = setInterval(emit, 100);
    try {
      emit();
      while (sources().size < 4) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        raw += decoder.decode(value, { stream: true });
        const blocks = raw.split('\n\n');
        raw = blocks.pop() ?? '';
        for (const block of blocks) {
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (line) {
            events.push(JSON.parse(line.slice(5)));
          }
        }
      }
    } finally {
      clearInterval(timer);
      abort.abort();
    }

    expect([...sources()].sort((a, b) => a.localeCompare(b))).toEqual([
      'mail',
      'outbox',
      'resilience',
      'workflow',
    ]);
    for (const event of events) {
      expect(opsEventSchema.parse(event)).toEqual(event);
    }
    const by = (source: string) => events.find((e) => e.source === source)!;
    expect(by('outbox')).toMatchObject({
      type: 'dead-lettered',
      error: {
        name: 'Error',
        message: `refused: Authorization: Bearer ${REDACTED}`,
      },
      message: {
        payload: { password: REDACTED, to: 'a@example.com' },
        headers: { authorization: REDACTED },
      },
    });
    expect(by('mail')).toMatchObject({
      type: 'failed',
      error: { message: 'mailbox full' },
    });
    // The event's own `source` no longer overwrites the stream's tag.
    expect(by('resilience')).toMatchObject({
      type: 'timeout',
      policy: 'upstream',
      origin: 'billing',
    });
    expect(by('workflow')).toMatchObject({
      type: 'workflow-failed',
      at: 5,
      error: { name: 'CardDeclinedError' },
    });
    const text = JSON.stringify(events);
    for (const secret of [token, password]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('pay.js');
    expect(text).not.toMatch(/\\n\s+at /);
  });
});
