import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Outbox } from '@nestjs/outbox';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import type { Database } from '../src/core/database/drizzle.js';
import { OutboxMetricsReader } from '../src/platform/ops/outbox-metrics.reader.js';
import { bootApp, type TestApp } from './support.js';

// METRICS_TOKEN is read while AppModule loads. The worker role registers the
// deployment-wide backlog gauges; this file's fresh process observes fixtures
// on its first scrape.
const TOKEN = vi.hoisted(() => {
  const token = 'outbox-metrics-e2e-token';
  process.env.METRICS_TOKEN = token;
  process.env.APP_ROLE = 'worker';
  return token;
});

describe('outbox metrics (PostgreSQL e2e)', () => {
  let node: TestApp;
  let now: number;

  beforeAll(async () => {
    node = await bootApp();
    now = Date.now();
    const db = node.app.get<Database>(getDrizzleToken());
    const inserted = await db.transaction(async (tx) =>
      node.app.get(Outbox).add(tx as never, [
        { topic: 'metrics.due', payload: { id: 'due' }, headers: {} },
        { topic: 'metrics.retry', payload: { id: 'retry' }, headers: {} },
        { topic: 'metrics.delayed', payload: { id: 'delayed' }, headers: {} },
      ]),
    );

    await db.execute(sql`
      UPDATE nest_outbox.messages
      SET created_at = ${now - 60_000}, available_at = ${now - 60_000}
      WHERE id = ${inserted[0]!.id}
    `);
    // Retried messages age from created_at, including while waiting for their
    // next attempt's available_at.
    await db.execute(sql`
      UPDATE nest_outbox.messages
      SET attempts = 1, created_at = ${now - 120_000}, available_at = ${now + 60_000}
      WHERE id = ${inserted[1]!.id}
    `);
    // A first attempt with a future due time contributes to pending but not lag.
    await db.execute(sql`
      UPDATE nest_outbox.messages
      SET created_at = ${now}, available_at = ${now + 60_000}
      WHERE id = ${inserted[2]!.id}
    `);
    await db.execute(sql`
      INSERT INTO nest_outbox.dead_letters
        (id, seq, topic, payload, headers, key, created_at, attempts, last_error, history, reason, failed_at)
      VALUES
        (${randomUUID()}, 999999, 'metrics.dead', NULL, '{}'::jsonb, NULL,
         ${now - 10_000}, 5, 'test failure', '[]'::jsonb, 'exhausted', ${now})
    `);
  }, 60_000);

  afterAll(async () => {
    await node.close();
  });

  it('exports pending, dead-letter and due lag from the real outbox tables', async () => {
    const snapshot = await node.app.get(OutboxMetricsReader).read();
    expect(snapshot).toEqual({
      pending: 3,
      deadLetters: 1,
      oldestDueAt: now - 120_000,
    });

    const response = await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(response.text).toMatch(/^outbox_undelivered 3$/m);
    expect(response.text).toMatch(/^outbox_dead_letters 1$/m);
    const lag = response.text.match(/^outbox_lag_seconds ([\d.]+)$/m);
    expect(lag).not.toBeNull();
    expect(Number(lag![1])).toBeGreaterThanOrEqual(120);
    expect(Number(lag![1])).toBeLessThan(180);
  });

  it('cancels a blocked read at its statement timeout and succeeds after the lock releases', async () => {
    const owner = new Client({ connectionString: node.database.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(
        'LOCK TABLE nest_outbox.messages IN ACCESS EXCLUSIVE MODE',
      );

      const started = Date.now();
      await expect(
        node.app.get(OutboxMetricsReader).read(),
      ).rejects.toMatchObject({
        cause: { code: '57014' },
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_200);
      expect(elapsed).toBeLessThan(5_000);

      await owner.query('ROLLBACK');
      await expect(node.app.get(OutboxMetricsReader).read()).resolves.toEqual({
        pending: 3,
        deadLetters: 1,
        oldestDueAt: now - 120_000,
      });
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
      await owner.end();
    }
  });

  it('leaves deployment-wide backlog gauges off in an API-only process', async () => {
    process.env.APP_ROLE = 'api';
    const api = await bootApp();
    try {
      const response = await api
        .http()
        .get('/metrics')
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(200);
      expect(response.text).not.toMatch(
        /^outbox_(undelivered|dead_letters|lag_seconds)\b/m,
      );
      expect(response.text).not.toMatch(/^queue_jobs\{/m);
    } finally {
      await api.close();
      process.env.APP_ROLE = 'worker';
    }
  });
});
