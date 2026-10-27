import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import {
  type Binding,
  BlindIndexer,
  DataCipher,
} from '../src/core/encryption/data-cipher.js';
import { EncryptionService } from '../src/core/encryption/encryption.service.js';
import { ReencryptionScheduler } from '../src/platform/encryption/reencryption.scheduler.js';
import {
  REENCRYPTION,
  REENCRYPTION_BATCH,
  type ReencryptionJob,
  ReencryptionService,
} from '../src/platform/encryption/reencryption.service.js';
import {
  TEST_TAX_NUMBER,
  testEncryptedRecords as records,
} from './fixtures/encrypted/encrypted-fixture.tables.js';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: a rotation under way, the new keys in front of
// the old ones, for the data and for the blind indexes; and /metrics served.
const KEYS = vi.hoisted(() => {
  // Runs before the imports: Web Crypto, a global.
  const make = () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const keys = {
    oldData: make(),
    newData: make(),
    oldIndex: make(),
    newIndex: make(),
    metrics: 'metrics-token-for-the-encryption-tests',
  };
  process.env.DATA_ENCRYPTION_KEYS = `${keys.newData},${keys.oldData}`;
  process.env.BLIND_INDEX_KEYS = `${keys.newIndex},${keys.oldIndex}`;
  process.env.METRICS_TOKEN = keys.metrics;
  return keys;
});

/**
 * Personal data at rest (docs/encryption.md, roadmap item 5): values
 * written under an old key still open, the re-encryption job moves every
 * tenant's rows onto the current keys in resumable batches without
 * overwriting a concurrent write, lookups by blind index find rows on
 * either key, and the stale rows are on /metrics.
 */
describe('encrypted columns and re-encryption (e2e)', () => {
  let node: TestApp;
  let encryption: EncryptionService;
  let reencryption: ReencryptionService;
  let queue: Queue<ReencryptionJob>;
  const oldCipher = new DataCipher([KEYS.oldData]);
  const oldIndexer = new BlindIndexer([KEYS.oldIndex]);
  const bindingOf = (tenantId: string): Binding => ({
    table: 'test_encrypted_records',
    column: 'tax_number',
    tenantId,
  });

  beforeAll(async () => {
    node = await bootApp();
    encryption = node.app.get(EncryptionService);
    reencryption = node.app.get(ReencryptionService);
    queue = node.app.get<Queue<ReencryptionJob>>(getQueueToken(REENCRYPTION));
  });
  afterAll(async () => {
    await node.close();
  });

  /** A row as an older deployment wrote it: both parts under the old keys. */
  const legacyRow = (tenantId: string, taxNumber: string) => ({
    tenantId,
    taxNumber: oldCipher.encrypt(taxNumber, bindingOf(tenantId)),
    taxNumberIndex: oldIndexer.index(taxNumber, bindingOf(tenantId)),
  });

  /** The rows of a tenant holding `value` (the test's pool passes row-level security: the tenant is named). */
  const find = (value: string, tenantId = node.tenantId) =>
    node.db
      .select()
      .from(records)
      .where(
        and(
          eq(records.tenantId, tenantId),
          encryption.lookup(records.taxNumber, value, tenantId),
        ),
      );

  const open = (stored: string | null, tenantId = node.tenantId) =>
    encryption.decrypt(records.taxNumber, stored, tenantId);

  /**
   * Waits for the workers (APP_ROLE all in the tests) to finish every
   * batch, the ones the batches queue too; returns how many completed.
   */
  const settled = async () => {
    await vi.waitFor(
      async () => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        expect(counts).toEqual({ waiting: 0, active: 0, delayed: 0 });
      },
      { timeout: 20_000, interval: 50 },
    );
    return queue.getCompletedCount();
  };

  const stale = () =>
    node.acrossTenants(() => reencryption.countStale(TEST_TAX_NUMBER));

  const metric = async () => {
    const res = await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${KEYS.metrics}`)
      .expect(200);
    const line = (res.text as string)
      .split('\n')
      .find((l) =>
        l.startsWith(
          'encrypted_rows_on_old_key{column="test_encrypted_records.tax_number"}',
        ),
      );
    return Number(line?.split(' ').pop());
  };

  it('writes under the current keys, bound to the tenant, and finds a row by value', async () => {
    const [row] = await node.db
      .insert(records)
      .values({
        tenantId: node.tenantId,
        ...encryption.seal(records.taxNumber, 'NEW-1', node.tenantId),
      })
      .returning();
    expect(row!.taxNumber).toMatch(
      new RegExp(`^v1\\.${encryption.currentKeyId}\\.`),
    );
    expect(row!.taxNumber).not.toContain('NEW-1');
    expect(row!.taxNumberIndex).toMatch(
      new RegExp(`^${encryption.currentIndexKeyId}\\.`),
    );
    // Normalized (exact: trimmed) before it is indexed.
    expect((await find(' NEW-1 ')).map((r) => r.id)).toEqual([row!.id]);
    expect(open(row!.taxNumber)).toBe('NEW-1');

    // Moved to another tenant, it no longer opens, and isn't found there.
    const other = await node.otherTenant();
    await node.db
      .insert(records)
      .values({ tenantId: other.id, taxNumber: row!.taxNumber });
    expect(() => open(row!.taxNumber, other.id)).toThrow(
      /authentication failed/,
    );
    expect(await find('NEW-1', other.id)).toEqual([]);
    await node.db.delete(records).where(eq(records.tenantId, other.id));
  });

  it('moves every tenant onto the current keys in resumable batches, leaving what does not open', async () => {
    const other = await node.otherTenant();
    const count = REENCRYPTION_BATCH + 7; // two batches in the seeded tenant
    await node.db
      .insert(records)
      .values(
        Array.from({ length: count }, (_, i) =>
          legacyRow(node.tenantId, `A-${i}`),
        ),
      );
    await node.db
      .insert(records)
      .values([legacyRow(other.id, 'B-0'), legacyRow(other.id, 'B-1')]);
    // A value under a key no longer listed: it can't be moved.
    const lost = new DataCipher([randomBytes(32).toString('base64')]);
    await node.db.insert(records).values({
      tenantId: other.id,
      taxNumber: lost.encrypt('LOST', bindingOf(other.id)),
      taxNumberIndex: oldIndexer.index('LOST', bindingOf(other.id)),
    });

    // Before the job: old rows open, and are found by their old index.
    const [before] = await find('A-3');
    expect(open(before!.taxNumber)).toBe('A-3');
    expect(await stale()).toBe(count + 3);
    expect(await metric()).toBe(count + 3);

    // The hourly schedule queues one job per tenant with stale rows.
    expect(await node.app.get(ReencryptionScheduler).run()).toBe(2);
    // Two batches in the seeded tenant (the first queues the second), one in the other.
    expect(await settled()).toBe(3);

    expect(await stale()).toBe(1); // the one that doesn't open
    expect(await metric()).toBe(1);
    const all = await node.db.select().from(records);
    const left = all.filter((row) =>
      encryption.isStale(TEST_TAX_NUMBER, row.taxNumber, row.taxNumberIndex),
    );
    expect(left.map((row) => row.taxNumber)).toEqual([
      expect.stringMatching(new RegExp(`^v1\\.${lost.currentKeyId}\\.`)),
    ]);

    const [moved] = await find('B-1', other.id);
    expect(moved!.taxNumberIndex).toBe(
      encryption.blindIndex(records.taxNumber, 'B-1', other.id),
    );
    expect(open(moved!.taxNumber, other.id)).toBe('B-1');
    const [last] = await find(`A-${count - 1}`);
    expect(open(last!.taxNumber)).toBe(`A-${count - 1}`);

    // Only the row that doesn't open is left: its tenant is queued again, and it stays.
    expect(await node.app.get(ReencryptionScheduler).run()).toBe(1);
    expect(await settled()).toBe(4);
    expect(await stale()).toBe(1);
    await node.db.delete(records).where(eq(records.tenantId, other.id));
  });

  it('never overwrites a value written between its read and its write', async () => {
    const [row] = await node.db
      .insert(records)
      .values(legacyRow(node.tenantId, 'RACE-OLD'))
      .returning();
    const concurrent = encryption.seal(
      records.taxNumber,
      'RACE-NEW',
      node.tenantId,
    );
    // A request's transaction changes the row and holds its lock…
    // (As the tables' owner, whom row-level security binds too: in the tenant.)
    const client = new Client({ connectionString: node.database.ownerUrl });
    await client.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [
        node.tenantId,
      ]);
      await client.query(
        'update test_encrypted_records set tax_number = $1, tax_number_index = $2 where id = $3',
        [concurrent.taxNumber, concurrent.taxNumberIndex, row!.id],
      );
      // …while the batch reads the old value and waits on the lock to write it back.
      const batch = node.inTenant(() => reencryption.batch(TEST_TAX_NUMBER));
      for (let i = 0; i < 100; i++) {
        const [waiting] = (
          await node.db.execute(
            sql`select count(*)::int as n from pg_locks where not granted`,
          )
        ).rows as { n: number }[];
        if (waiting!.n > 0) {
          break;
        }
        await sleep(20);
      }
      await client.query('commit');
      expect(await batch).toMatchObject({
        rewritten: 0,
        skipped: 1,
        failed: 0,
      });
    } finally {
      await client.end();
    }
    const [after] = await node.db
      .select()
      .from(records)
      .where(eq(records.id, row!.id));
    expect(open(after!.taxNumber)).toBe('RACE-NEW');
    expect(after!.taxNumberIndex).toBe(concurrent.taxNumberIndex);
  });
});
