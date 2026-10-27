import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Outbox, OutboxDeadLetters } from '@nestjs/outbox';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { OutboxRetentionJob } from '../src/platform/ops/outbox-retention.job.js';
import { bootApp, type TestApp } from './support.js';

const DAY = 86_400_000;

/** The nightly outbox retention (e2e): old dead letters and inbox records go, recent ones stay. */
describe('outbox retention (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  /** A message the outbox gave up on, failed `ageMs` ago. */
  async function deadLetter(ageMs: number) {
    const db = node.app.get<Database>(getDrizzleToken());
    const store = node.app.get(PostgresOutboxStore);
    const [added] = await db.transaction(async (tx) =>
      node.app.get(Outbox).add(tx as never, [
        {
          topic: 'retention.test',
          key: 'retention-test',
          payload: {},
          headers: {},
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
    const failedAt = Date.now() - ageMs;
    const moved = await store.deadLetter(added!.id, owner, {
      attempts: 5,
      reason: 'exhausted',
      failedAt,
      error: { attempt: 5, at: failedAt, error: 'boom', transport: 'local' },
    });
    expect(moved).toBe(true);
    return added!.id;
  }

  it('deletes dead letters and inbox records past their retention, and audits the purge', async () => {
    const store = node.app.get(PostgresOutboxStore);
    const oldLetter = await deadLetter(20 * DAY);
    const recentLetter = await deadLetter(DAY);
    const oldInbox = randomUUID();
    const recentInbox = randomUUID();
    await store.recordInbox(undefined, 'test', oldInbox, Date.now() - 40 * DAY);
    await store.recordInbox(undefined, 'test', recentInbox, Date.now() - DAY);

    const job = node.app.get(OutboxRetentionJob);
    expect(await job.run()).toEqual({ deadLetters: 1, inbox: 1 });

    const left = (await node.app.get(OutboxDeadLetters).list()).map(
      (letter) => letter.id,
    );
    expect(left).toContain(recentLetter);
    expect(left).not.toContain(oldLetter);
    expect(await store.hasInbox('test', oldInbox)).toBe(false);
    expect(await store.hasInbox('test', recentInbox)).toBe(true);

    const audited = () =>
      node.db
        .select({ actor: auditLog.actor, details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.action, 'outbox.dead-letters-purged'));
    const entries = await audited();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: 'system:outbox-retention',
      details: { purged: 1 },
    });

    expect(await job.run()).toEqual({ deadLetters: 0, inbox: 0 });
    expect(await audited()).toHaveLength(1);
  });
});
