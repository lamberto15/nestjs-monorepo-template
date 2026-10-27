import type { TransactionHost } from '@nestjs-cls/transactional';
import { inArray, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Transaction } from './drizzle.js';
import { type DrizzleTransactions, inTransaction } from './transactions.js';

/** Rows per batch: one short transaction each (no long lock, no WAL burst, no big result). */
export const DELETE_BATCH = 5000;

/**
 * Deletes the rows of `table` matching `where`, DELETE_BATCH at a time, each batch in its own
 * transaction (`afterBatch` runs in it: an audit entry commits with its rows). Returns how many.
 * Refused inside an open transaction: the batches would join it and be one again.
 * `id` is a unique column of `table`: the primary key.
 */
export async function deleteInBatches(
  txHost: TransactionHost<DrizzleTransactions>,
  table: PgTable,
  id: PgColumn,
  where: SQL | undefined,
  options: {
    batchSize?: number;
    afterBatch?: (tx: Transaction, deleted: number) => Promise<unknown>;
  } = {},
): Promise<number> {
  if (txHost.isTransactionActive()) {
    throw new Error(
      'deleteInBatches() cannot run inside an open transaction: its batches would join it',
    );
  }
  const batchSize = options.batchSize ?? DELETE_BATCH;
  let total = 0;
  for (;;) {
    const count = await inTransaction(txHost, async (tx) => {
      const result = await tx
        .delete(table)
        .where(
          inArray(
            id,
            tx.select({ id }).from(table).where(where).limit(batchSize),
          ),
        );
      // Database's portable result type is unknown; node-postgres reports rowCount.
      const deleted = (result as { rowCount?: number | null }).rowCount ?? 0;
      if (deleted > 0) {
        await options.afterBatch?.(tx, deleted);
      }
      return deleted;
    });
    total += count;
    if (count < batchSize) {
      return total;
    }
  }
}
