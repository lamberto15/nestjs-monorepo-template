import { TransactionHost } from '@nestjs-cls/transactional';
import { inTransaction } from '../src/core/database/transactions.js';
import { SequencesService } from '../src/platform/sequences/sequences.service.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The platform's gapless sequences, through the service. The numbers a
 * feature's records carry (NOTE-2026-00001) are tested with that feature:
 * the feature's own spec (test/features/<feature>/).
 */
describe('sequences: gapless human-readable numbers (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  it('numbers per year without gaps, even taken at once or rolled back', async () => {
    const sequences = node.app.get(SequencesService);
    const txHost = node.app.get(TransactionHost);
    const year = new Date().getUTCFullYear();
    const options = { prefix: 'TST', perYear: true, width: 5 };
    const next = () =>
      node.inTenant(() =>
        inTransaction(txHost, (tx) => sequences.next(tx, 'test', options)),
      );
    expect((await next()).formatted).toBe(`TST-${year}-00001`);

    // Twenty at once: twenty different, contiguous numbers.
    const taken = await Promise.all(Array.from({ length: 20 }, next));
    const numbers = taken.map((number) => number.formatted).toSorted();
    expect(new Set(numbers).size).toBe(20);
    expect(numbers[0]).toBe(`TST-${year}-00002`);
    expect(numbers[19]).toBe(`TST-${year}-00021`);

    // A write that rolls back takes no number.
    await expect(
      node.inTenant(() =>
        inTransaction(txHost, async (tx) => {
          await sequences.next(tx, 'test', options);
          throw new Error('changed my mind');
        }),
      ),
    ).rejects.toThrow('changed my mind');
    expect((await next()).formatted).toBe(`TST-${year}-00022`);
    expect(
      await node.inTenant(() => sequences.current('test', { perYear: true })),
    ).toBe(22);

    // Another year, another scope: their own series.
    const lastYear = new Date(Date.UTC(year - 1, 5, 1));
    const other = await node.inTenant(() =>
      inTransaction(txHost, (tx) =>
        sequences.next(tx, 'test', { ...options, at: lastYear }),
      ),
    );
    expect(other.formatted).toBe(`TST-${year - 1}-00001`);
    const scoped = await node.inTenant(() =>
      inTransaction(txHost, (tx) =>
        sequences.next(tx, 'invoice', {
          scope: 'unit-a',
          prefix: 'INV',
          width: 3,
        }),
      ),
    );
    expect(scoped).toEqual({ value: 1, formatted: 'INV-001' });
  });
});
