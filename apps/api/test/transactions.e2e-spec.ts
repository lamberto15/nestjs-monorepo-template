import { TransactionHost } from '@nestjs-cls/transactional';
import { eq } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../src/core/database/transactions.js';
import { AuditService } from '../src/iam/audit/audit.service.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp } from './support.js';

/** Transactions follow the call: services join the current one without being handed `tx`. */
describe('transactions (e2e)', () => {
  let node: TestApp;
  let txHost: TransactionHost<DrizzleTransactions>;
  let audit: AuditService;

  beforeAll(async () => {
    node = await bootApp();
    txHost = node.app.get(TransactionHost);
    audit = node.app.get(AuditService);
  });
  afterAll(() => node.close());

  const entries = (action: string) =>
    database(txHost).select().from(auditLog).where(eq(auditLog.action, action));

  it('rolls back what another service wrote inside, without being handed tx', async () => {
    await expect(
      inTransaction(txHost, async () => {
        // AuditService writes through its own `this.db`: here, the transaction.
        await audit.record(null, { action: 'test.rolled-back' });
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await entries('test.rolled-back')).toHaveLength(0);

    await inTransaction(txHost, () =>
      audit.record(null, { action: 'test.committed' }),
    );
    expect(await entries('test.committed')).toHaveLength(1);
  });

  it('joins the current transaction when nested (one commit, one rollback)', async () => {
    await expect(
      inTransaction(txHost, async () => {
        await inTransaction(txHost, () =>
          audit.record(null, { action: 'test.nested' }),
        );
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(await entries('test.nested')).toHaveLength(0);
  });
});
