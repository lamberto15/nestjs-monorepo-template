import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import type request from 'supertest';
import { inTransaction } from '../src/core/database/transactions.js';
import { dateValues } from '../src/platform/sequences/naming-pattern.js';
import { NamingSeriesService } from '../src/platform/sequences/naming-series.service.js';
import { bootApp, type TestApp } from './support.js';

/**
 * Naming series: the number formats administrators define for numbered
 * records (platform/sequences), on test items (a generated record: the
 * numbers come through RecordLifecycle). Notes (a hand-written service):
 * the notes feature's own naming-series spec.
 */
describe('naming series (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);

  /** Today's date parts, in the app's time zone, as the numbers print them. */
  const today = () =>
    dateValues(
      new Date(),
      node.app.get(ConfigService).get('APP_TIMEZONE') as string,
    );

  const series = async (
    pattern: string,
    extra: Record<string, unknown> = {},
    agent: request.Agent = node.admin(),
  ) =>
    (
      await agent
        .post('/v1/naming-series')
        .send({ subject: 'TestItem', pattern, ...extra })
        .expect(201)
    ).body as { id: string; isDefault: boolean; example: string };

  const item = async (
    extra: Record<string, unknown> = {},
    agent: request.Agent = node.admin(),
  ) =>
    agent
      .post('/v1/test-items')
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Numbered', ...extra });

  const numberOf = async (extra: Record<string, unknown> = {}) => {
    const created = await item(extra);
    expect(created.status).toBe(201);
    return created.body.number as string;
  };

  it('lets only naming series managers change them; anyone signed in reads them', async () => {
    const editor = await node.user(['editor']);
    await editor.agent
      .post('/v1/naming-series')
      .send({ subject: 'TestItem', pattern: 'X-.###' })
      .expect(403);

    const subjects = await editor.agent
      .get('/v1/naming-series/subjects')
      .expect(200);
    expect(subjects.body.items).toEqual(
      expect.arrayContaining([
        { subject: 'TestItem', declaredPattern: 'TI-.YYYY.-.#####' },
      ]),
    );

    const { id } = await series('TI-.YYYY.-.#####', { label: 'Items' });
    const listed = await editor.agent
      .get('/v1/naming-series?subject=TestItem')
      .expect(200);
    expect(listed.body.items).toMatchObject([
      { id, pattern: 'TI-.YYYY.-.#####', label: 'Items', isDefault: true },
    ]);
    await editor.agent
      .patch(`/v1/naming-series/${id}`)
      .send({ label: 'Mine' })
      .expect(403);
    await editor.agent
      .put(`/v1/naming-series/${id}/counter`)
      .send({ current: 10 })
      .expect(403);
    await editor.agent.delete(`/v1/naming-series/${id}`).expect(403);
    await editor.agent
      .get('/v1/naming-series/preview?subject=TestItem&pattern=X-.%23%23%23')
      .expect(403);
  });

  it('refuses invalid patterns, unknown subjects and a pattern taken', async () => {
    for (const pattern of ['INV-.YYYY.', '.###.-.###', 'IN<V>.###']) {
      const refused = await node
        .admin()
        .post('/v1/naming-series')
        .send({ subject: 'TestItem', pattern })
        .expect(400);
      expect(paths(refused.body)).toEqual(['pattern']);
    }
    const unknown = await node
      .admin()
      .post('/v1/naming-series')
      .send({ subject: 'Invoice', pattern: 'INV-.###' })
      .expect(400);
    expect(paths(unknown.body)).toEqual(['subject']);

    await series('A-.###');
    const taken = await node
      .admin()
      .post('/v1/naming-series')
      .send({ subject: 'TestItem', pattern: 'A-.###' })
      .expect(409);
    expect(taken.body.code).toBe('conflict');

    const preview = await node
      .admin()
      .get('/v1/naming-series/preview')
      .query({ subject: 'TestItem', pattern: 'A-.' })
      .expect(400);
    expect(paths(preview.body)).toEqual(['pattern']);
  });

  it('numbers in the default series or the one the body names, carrying on the declared counter', async () => {
    const { YYYY, MM } = today();
    // Before any series: the declared format.
    expect(await numberOf()).toBe(`TI-${YYYY}-00001`);
    expect(await numberOf()).toBe(`TI-${YYYY}-00002`);

    // The first series is the default; printing what the declared format
    // prints, it carries on its counter: no second TI-<year>-00001.
    const main = await series('TI-.YYYY.-.#####');
    expect(main).toMatchObject({
      isDefault: true,
      example: `TI-${YYYY}-00003`,
    });
    expect(await numberOf()).toBe(`TI-${YYYY}-00003`);

    // Another series, per month, picked by the body.
    const monthly = await series('CN-.YYYY.-.MM.-.###', {
      label: 'Credit notes',
    });
    expect(monthly.isDefault).toBe(false);
    expect(await numberOf({ namingSeriesId: monthly.id })).toBe(
      `CN-${YYYY}-${MM}-001`,
    );
    expect(await numberOf()).toBe(`TI-${YYYY}-00004`);

    // Made the default, it numbers what names none; the other stops being it.
    await node
      .admin()
      .patch(`/v1/naming-series/${monthly.id}`)
      .send({ isDefault: true })
      .expect(200);
    expect(await numberOf()).toBe(`CN-${YYYY}-${MM}-002`);
    const defaults = await node
      .admin()
      .get('/v1/naming-series?subject=TestItem&isDefault=true')
      .expect(200);
    expect(defaults.body.items.map((row: { id: string }) => row.id)).toEqual([
      monthly.id,
    ]);

    // No such series: refused, nothing created (another subject's: the notes feature's spec).
    const refused = await item({ namingSeriesId: randomUUID() });
    expect(refused.status).toBe(400);
    expect(paths(refused.body)).toEqual(['namingSeriesId']);
    // Chosen once: an update's series changes nothing.
    const created = await item();
    expect(created.body.number).toBe(`CN-${YYYY}-${MM}-003`);
    const updated = await node
      .admin()
      .patch(`/v1/test-items/${created.body.id}`)
      .set('If-Match', created.headers.etag as string)
      .send({ namingSeriesId: main.id })
      .expect(200);
    expect(updated.body.number).toBe(`CN-${YYYY}-${MM}-003`);

    // Deleting the default: the oldest series left takes over.
    await node.admin().delete(`/v1/naming-series/${monthly.id}`).expect(204);
    const left = await node
      .admin()
      .get(`/v1/naming-series/${main.id}`)
      .expect(200);
    expect(left.body.isDefault).toBe(true);
    expect(await numberOf()).toBe(`TI-${YYYY}-00005`);
  });

  it('starts a counter at a value, never below what is taken', async () => {
    const { YYYY } = today();
    const { id } = await series('INV-.YYYY.-.####');
    expect(await numberOf()).toBe(`INV-${YYYY}-0001`);

    const set = await node
      .admin()
      .put(`/v1/naming-series/${id}/counter`)
      .send({ current: 1000 })
      .expect(200);
    expect(set.body).toEqual({
      key: `INV-${YYYY}-{#}`,
      current: 1000,
      next: `INV-${YYYY}-1001`,
    });
    expect(await numberOf()).toBe(`INV-${YYYY}-1001`);

    const below = await node
      .admin()
      .put(`/v1/naming-series/${id}/counter`)
      .send({ current: 1000 })
      .expect(409);
    expect(below.body.code).toBe('conflict');
    const counter = await node
      .admin()
      .get(`/v1/naming-series/${id}/counter`)
      .expect(200);
    expect(counter.body.current).toBe(1001);

    // A pattern printing the same shares the counter, whatever its width.
    const preview = await node
      .admin()
      .get('/v1/naming-series/preview')
      .query({ subject: 'TestItem', pattern: 'INV-.YYYY.-.######' })
      .expect(200);
    expect(preview.body).toEqual({
      key: `INV-${YYYY}-{#}`,
      current: 1001,
      next: `INV-${YYYY}-001002`,
    });

    const audit = await node
      .admin()
      .get('/v1/access/audit?action=namingSeries.counterSet')
      .expect(200);
    expect(audit.body.items[0]).toMatchObject({
      action: 'namingSeries.counterSet',
      targetId: id,
      details: { from: 1, to: 1000 },
    });
  });

  it('gives each of many writes at once its own number', async () => {
    const { YYYY } = today();
    await series('B-.YYYY.-.###');
    const numbers = await Promise.all(
      Array.from({ length: 12 }, () => numberOf()),
    );
    expect(numbers.toSorted()).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `B-${YYYY}-${String(index + 1).padStart(3, '0')}`,
      ),
    );
  });

  it('restarts a series when its date parts change', async () => {
    const service = node.app.get(NamingSeriesService);
    const txHost = node.app.get(TransactionHost);
    const { id } = await series('M-.YY.MM.-.##');
    const take = (at: Date) =>
      node.inTenant(() =>
        inTransaction(txHost, (tx) =>
          service.next(tx, 'TestItem', { seriesId: id, at }),
        ),
      );
    const january = new Date('2030-01-15T12:00:00Z');
    const february = new Date('2030-02-15T12:00:00Z');
    expect((await take(january)).formatted).toBe('M-3001-01');
    expect((await take(january)).formatted).toBe('M-3001-02');
    expect((await take(february)).formatted).toBe('M-3002-01');
    expect((await take(january)).formatted).toBe('M-3001-03');
  });

  it("keeps a tenant's series and counters its own", async () => {
    const { YYYY } = today();
    await series('OURS-.###');
    expect(await numberOf()).toBe('OURS-001');

    const other = await node.otherTenant();
    const theirs = await other.admin
      .get('/v1/naming-series?subject=TestItem')
      .expect(200);
    expect(theirs.body.items).toEqual([]);
    const created = await item({}, other.admin);
    expect(created.status).toBe(201);
    expect(created.body.number).toBe(`TI-${YYYY}-00001`);
    await series('OURS-.###', {}, other.admin);
    expect((await item({}, other.admin)).body.number).toBe('OURS-001');
  });
});
