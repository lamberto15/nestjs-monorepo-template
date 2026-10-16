import { TransactionHost } from '@nestjs-cls/transactional';
import { inTransaction } from '../src/core/database/transactions.js';
import { SequencesService } from '../src/platform/sequences/sequences.service.js';
import { bootApp, type TestApp } from './support.js';

describe('sequences: gapless human-readable numbers (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  it('numbers notes per year without gaps, even written at once or rolled back', async () => {
    const client = await node.client();
    const year = new Date().getUTCFullYear();
    const first = (await node.writeNote(client.auth).expect(201)).body;
    expect(first.number).toBe(`NOTE-${year}-00001`);
    expect(first).not.toHaveProperty('search');

    // Twenty at once: twenty different, contiguous numbers.
    const written = await Promise.all(
      Array.from({ length: 20 }, () => node.writeNote(client.auth).expect(201)),
    );
    const numbers = written
      .map((response) => response.body.number as string)
      .toSorted();
    expect(new Set(numbers).size).toBe(20);
    expect(numbers[0]).toBe(`NOTE-${year}-00002`);
    expect(numbers[19]).toBe(`NOTE-${year}-00021`);

    // A write that rolls back takes no number.
    const sequences = node.app.get(SequencesService);
    const txHost = node.app.get(TransactionHost);
    await expect(
      inTransaction(txHost, async (tx) => {
        await sequences.next(tx, 'note', {
          prefix: 'NOTE',
          perYear: true,
          width: 5,
        });
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect((await node.writeNote(client.auth).expect(201)).body.number).toBe(
      `NOTE-${year}-00022`,
    );
    expect(await sequences.current('note', { perYear: true })).toBe(22);

    // Another year, another scope: their own series.
    const lastYear = new Date(Date.UTC(year - 1, 5, 1));
    const other = await inTransaction(txHost, (tx) =>
      sequences.next(tx, 'note', {
        prefix: 'NOTE',
        perYear: true,
        width: 5,
        at: lastYear,
      }),
    );
    expect(other.formatted).toBe(`NOTE-${year - 1}-00001`);
    const scoped = await inTransaction(txHost, (tx) =>
      sequences.next(tx, 'invoice', {
        scope: 'unit-a',
        prefix: 'INV',
        width: 3,
      }),
    );
    expect(scoped).toEqual({ value: 1, formatted: 'INV-001' });

    // Listed, filtered and sorted like any field.
    const found = await node
      .http()
      .get(`/v1/notes?number=NOTE-${year}-00002`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(found.body.items.map((n: { number: string }) => n.number)).toEqual([
      `NOTE-${year}-00002`,
    ]);
    const sorted = await node
      .http()
      .get('/v1/notes?sort=number&limit=2')
      .set('Authorization', client.auth)
      .expect(200);
    expect(sorted.body.items.map((n: { number: string }) => n.number)).toEqual([
      `NOTE-${year}-00001`,
      `NOTE-${year}-00002`,
    ]);
  });
});
