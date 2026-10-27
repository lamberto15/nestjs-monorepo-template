import { TransactionHost } from '@nestjs-cls/transactional';
import { lt } from 'drizzle-orm';
import { deleteInBatches } from '../src/core/database/batched-delete.js';
import { inTransaction } from '../src/core/database/transactions.js';
import { mailEvents } from '../src/platform/deliverability/deliverability.tables.js';
import { bootApp, type TestApp } from './support.js';

describe('deleteInBatches', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  it('deletes the matching rows batch by batch and refuses an open transaction', async () => {
    const txHost = node.app.get(TransactionHost);
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const row = (n: number, createdAt: Date) => ({
      provider: 'ses',
      eventId: `batched-delete-${n}`,
      type: 'delivery',
      address: `batched-${n}@example.com`,
      occurredAt: createdAt,
      createdAt,
    });
    await node.db
      .insert(mailEvents)
      .values([
        ...[1, 2, 3, 4, 5].map((n) => row(n, new Date('2025-01-01T00:00:00Z'))),
        row(6, new Date('2026-06-01T00:00:00Z')),
      ]);

    const batches: number[] = [];
    await expect(
      inTransaction(txHost, () =>
        deleteInBatches(
          txHost,
          mailEvents,
          mailEvents.id,
          lt(mailEvents.createdAt, cutoff),
        ),
      ),
    ).rejects.toThrow('open transaction');

    const deleted = await deleteInBatches(
      txHost,
      mailEvents,
      mailEvents.id,
      lt(mailEvents.createdAt, cutoff),
      {
        batchSize: 2,
        afterBatch: async (_tx, count) => {
          batches.push(count);
        },
      },
    );

    expect(deleted).toBe(5);
    expect(batches).toEqual([2, 2, 1]);
    const left = await node.db.select().from(mailEvents);
    expect(left.map((r) => r.eventId)).toEqual(['batched-delete-6']);
  });
});
