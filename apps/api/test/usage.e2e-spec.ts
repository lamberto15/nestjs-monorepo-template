import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Database } from '../src/core/database/drizzle.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { addDays, utcDay } from '../src/platform/usage/usage-keys.js';
import { UsageRollupJob } from '../src/platform/usage/usage-rollup.job.js';
import { apiUsage } from '../src/platform/usage/usage.tables.js';
import { bootApp, type TestApp } from './support.js';

describe('API usage and quotas (e2e)', () => {
  let node: TestApp;
  let db: Database;

  beforeAll(async () => {
    node = await bootApp();
    db = node.app.get<Database>(getDrizzleToken());
  });
  afterAll(async () => {
    await node.close();
  });

  /** A client that wrote a note and read it twice: 3 requests on 2 routes. */
  async function busyClient() {
    const client = await node.client();
    const note = await node.writeNote(client.auth).expect(201);
    for (let i = 0; i < 2; i++) {
      await node
        .http()
        .get(`/v1/notes/${note.body.id}`)
        .set('Authorization', client.auth)
        .expect(200);
    }
    return client;
  }

  const expectedToday = () => ({
    day: utcDay(),
    total: 3,
    routes: { 'GET /v1/notes/{id}': 2, 'POST /v1/notes': 1 },
  });

  it('counts a client’s requests per route pattern, today included, for the client and its administrators', async () => {
    const client = await busyClient();

    const own = await node
      .http()
      .get('/v1/usage')
      .set('Authorization', client.auth)
      .expect(200);
    expect(own.body.to).toBe(utcDay());
    expect(own.body.from).toBe(addDays(utcDay(), -29));
    expect(own.body.days).toHaveLength(30);
    expect(own.body.days.at(-1)).toEqual(expectedToday());
    expect(own.body.total).toBe(3);

    // The admin's view: the client's own GET /v1/usage counted too, after its response.
    const seen = await node
      .admin()
      .get(`/v1/access/clients/${client.id}/usage?from=${utcDay()}`)
      .expect(200);
    expect(seen.body).toEqual({
      from: utcDay(),
      to: utcDay(),
      days: [
        {
          day: utcDay(),
          total: 4,
          routes: { ...expectedToday().routes, 'GET /v1/usage': 1 },
        },
      ],
      total: 4,
    });
    // Administrators' own requests are not counted anywhere.
    await node
      .admin()
      .get(`/v1/access/clients/${client.id}/usage`)
      .expect(200)
      .expect((res) => expect(res.body.total).toBe(4));
  });

  it('keeps the usage to client managers and API clients', async () => {
    const client = await node.client();
    const viewer = (await node.user(['viewer'])).agent;
    await viewer.get(`/v1/access/clients/${client.id}/usage`).expect(403);
    const asUser = await node.admin().get('/v1/usage').expect(403);
    expect(asUser.body.code).toBe('forbidden');
    await node.http().get('/v1/usage').expect(401);
    await node
      .admin()
      .get('/v1/access/clients/0199a3f2-0000-7000-8000-000000000000/usage')
      .expect(404);
    const backwards = await node
      .admin()
      .get(
        `/v1/access/clients/${client.id}/usage?from=2026-02-02&to=2026-02-01`,
      )
      .expect(400);
    expect(backwards.body.code).toBe('validation_failed');
    await node
      .admin()
      .get(
        `/v1/access/clients/${client.id}/usage?from=2020-01-01&to=2026-01-01`,
      )
      .expect(400);
  });

  it('holds a burst of parallel requests to exactly the quota', async () => {
    const client = await node.client();
    await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ dailyQuota: 5 })
      .expect(200);
    const answers = await Promise.all(
      Array.from({ length: 12 }, () =>
        node.http().get('/v1/notes').set('Authorization', client.auth),
      ),
    );
    const statuses = answers
      .map((answer) => answer.status)
      .sort((a, b) => a - b);
    expect(statuses).toEqual([
      200, 200, 200, 200, 200, 429, 429, 429, 429, 429, 429, 429,
    ]);
    // The ones let through took the places 1 to 5: remaining 4, 3, 2, 1, 0.
    expect(
      answers
        .filter((answer) => answer.status === 200)
        .map((answer) => Number(answer.headers['x-quota-remaining']))
        .sort((a, b) => a - b),
    ).toEqual([0, 1, 2, 3, 4]);
    // The refused ones were given back: exactly 5 counted (the client's own
    // usage route is under its quota too, so the administrator looks).
    const usage = await node
      .admin()
      .get(`/v1/access/clients/${client.id}/usage?from=${utcDay()}`)
      .expect(200);
    expect(usage.body.total).toBe(5);
  });

  it('refuses a client past its daily quota with 429 quota_exceeded, until midnight UTC', async () => {
    const client = await node.client();
    const changed = await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ dailyQuota: 2 })
      .expect(200);
    expect(changed.body.dailyQuota).toBe(2);

    const firstKey = randomUUID();
    const first = await node
      .writeNote(client.auth, undefined, firstKey)
      .expect(201);
    expect(first.headers['x-quota-limit']).toBe('2');
    expect(first.headers['x-quota-remaining']).toBe('1');
    const second = await node
      .http()
      .get(`/v1/notes/${first.body.id}`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(second.headers['x-quota-remaining']).toBe('0');

    const refused = await node
      .http()
      .get(`/v1/notes/${first.body.id}`)
      .set('Authorization', client.auth)
      .expect(429);
    expect(refused.body.code).toBe('quota_exceeded');
    expect(refused.headers['x-quota-limit']).toBe('2');
    expect(refused.headers['x-quota-remaining']).toBe('0');
    const reset = Number(refused.headers['x-quota-reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(86_400);
    expect(refused.headers['retry-after']).toBe(String(reset));

    // Metering runs before idempotency: past the quota, even a replay is refused.
    const replay = await node
      .writeNote(client.auth, undefined, firstKey)
      .expect(429);
    expect(replay.body.code).toBe('quota_exceeded');

    // A refused write isn't kept for its Idempotency-Key: the retry runs.
    const retryKey = randomUUID();
    await node
      .writeNote(client.auth, { title: 'Later', body: 'x' }, retryKey)
      .expect(429);

    // Refused requests aren't counted.
    const usage = await node
      .admin()
      .get(`/v1/access/clients/${client.id}/usage?from=${utcDay()}`)
      .expect(200);
    expect(usage.body.total).toBe(2);

    // The change is audited; null lifts the quota.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'client.quota-changed'),
          eq(auditLog.targetId, client.id),
        ),
      );
    expect(entry.details).toEqual({ dailyQuota: { from: null, to: 2 } });
    await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ dailyQuota: null })
      .expect(200);
    const free = await node
      .writeNote(client.auth, { title: 'Later', body: 'x' }, retryKey)
      .expect(201);
    expect(free.headers['x-quota-limit']).toBeUndefined();
    await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ dailyQuota: 0 })
      .expect(400);
  });

  it('rolls the counters up into the table, answers the same from it, and deletes old rows', async () => {
    const client = await busyClient();
    const job = node.app.get(UsageRollupJob);

    expect(await job.run(utcDay())).toBeGreaterThanOrEqual(2);
    const rows = await db
      .select()
      .from(apiUsage)
      .where(eq(apiUsage.clientId, client.id));
    expect(
      Object.fromEntries(rows.map((row) => [row.route, row.count])),
    ).toEqual(expectedToday().routes);

    const fromTable = await node
      .admin()
      .get(`/v1/access/clients/${client.id}/usage?from=${utcDay()}`)
      .expect(200);
    expect(fromTable.body.days).toEqual([expectedToday()]);

    // A run without a day leaves today's counters alone.
    await node.writeNote(client.auth).expect(201);
    await job.run();
    const live = await node
      .admin()
      .get(`/v1/access/clients/${client.id}/usage?from=${utcDay()}`)
      .expect(200);
    expect(live.body.total).toBe(4);

    // The night after: today's counters copied, then deleted; the table answers alone.
    const tomorrow = new Date(Date.parse(`${addDays(utcDay(), 1)}T00:20:00Z`));
    await job.run(undefined, tomorrow);
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis
      .keys(`${process.env.REDIS_PREFIX}:usage:${client.id}:*`)
      .finally(() => redis.disconnect());
    expect(keys).toEqual([]);
    const rolled = await node
      .admin()
      .get(`/v1/access/clients/${client.id}/usage?from=${utcDay()}`)
      .expect(200);
    expect(rolled.body).toEqual(live.body);

    // Older than USAGE_RETENTION_DAYS (400): deleted.
    const old = addDays(utcDay(), -401);
    await db.insert(apiUsage).values({
      clientId: client.id,
      day: old,
      route: 'GET /v1/notes',
      count: 7,
    });
    await job.run();
    const left = await db
      .select({ day: apiUsage.day })
      .from(apiUsage)
      .where(and(eq(apiUsage.clientId, client.id), eq(apiUsage.day, old)));
    expect(left).toEqual([]);
  });
});
