import type { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import type { Database, Transaction } from './drizzle.js';

/**
 * Transactions that follow the call (nestjs-cls, AsyncLocalStorage): inside
 * `inTransaction()` (or a `@Transactional()` method), `txHost.tx` is the
 * transaction, in this service and in every service it calls; outside, it's
 * the database. Services read the database through it:
 *
 * ```ts
 * constructor(private readonly txHost: TransactionHost<DrizzleTransactions>) {}
 * private get db() { return database(this.txHost); }
 * ```
 *
 * so a query can't run outside the transaction it belongs to (where it
 * wouldn't see the transaction's rows, or would wait on its locks), and a
 * service called inside a transaction joins it without being handed `tx`.
 *
 * Not for what must outlive a rollback or never wait on one: locks, sessions,
 * API keys' last use, idempotency records, health checks inject the database
 * itself (`@InjectDrizzle()`).
 */
export type DrizzleTransactions = TransactionalAdapterDrizzleOrm<Database>;

/** The current transaction, or the database outside one. */
export const database = (txHost: TransactionHost<DrizzleTransactions>) =>
  txHost.tx as Database;

/**
 * Runs `work` in a transaction, joining the current one if there is one
 * (propagation Required). Every query through `txHost.tx` inside, in any
 * service, is part of it; `tx` is the same, handed over for clarity.
 */
export function inTransaction<T>(
  txHost: TransactionHost<DrizzleTransactions>,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return txHost.withTransaction(() =>
    work(txHost.tx as unknown as Transaction),
  );
}

/** Transaction options, or undefined when there are none. */
const options = <T extends object>(value: T | undefined) =>
  value && Object.keys(value).length > 0 ? value : undefined;

/**
 * The Drizzle adapter, minus one mismatch: the transaction host hands it `{}`
 * when no options were given, and Drizzle turns any options object into
 * `set transaction <…>`, here `set transaction ` alone (a syntax error).
 * Empty options are dropped; real ones (isolation level…) pass through.
 */
export class DrizzleTransactionAdapter extends TransactionalAdapterDrizzleOrm<Database> {
  constructor(
    settings: ConstructorParameters<typeof TransactionalAdapterDrizzleOrm>[0],
  ) {
    super(settings);
    const factory = this.optionsFactory;
    this.optionsFactory = (instance) => {
      const adapter = factory(instance);
      return {
        ...adapter,
        wrapWithTransaction: (given, work, setClient) =>
          adapter.wrapWithTransaction(options(given), work, setClient),
        wrapWithNestedTransaction: (given, work, setClient, client) =>
          adapter.wrapWithNestedTransaction!(
            options(given),
            work,
            setClient,
            client,
          ),
      };
    };
  }
}
