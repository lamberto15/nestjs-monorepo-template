import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { dateValues } from '../../../src/platform/sequences/naming-pattern.js';
import { bootApp, type TestApp } from '../../support.js';

/** Naming series on notes: a hand-written service numbering through NamingSeriesService. */
describe('naming series on notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const today = () =>
    dateValues(
      new Date(),
      node.app.get(ConfigService).get('APP_TIMEZONE') as string,
    );

  it('numbers notes in the series their body names', async () => {
    const { YYYY } = today();
    const note = (extra: Record<string, unknown> = {}) =>
      node
        .admin()
        .post('/v1/notes')
        .set('Idempotency-Key', randomUUID())
        .send({ title: 'Numbered', body: 'Text', ...extra })
        .expect(201);
    expect((await note()).body.number).toBe(`NOTE-${YYYY}-00001`);
    const memo = await node
      .admin()
      .post('/v1/naming-series')
      .send({ subject: 'Note', pattern: 'MEMO-.####', isDefault: false })
      .expect(201);
    // The subject's first series is its default, whatever the body says.
    expect(memo.body.isDefault).toBe(true);
    const kept = await node
      .admin()
      .post('/v1/naming-series')
      .send({ subject: 'Note', pattern: 'NOTE-.YYYY.-.#####' })
      .expect(201);
    expect((await note()).body.number).toBe('MEMO-0001');
    expect((await note({ namingSeriesId: kept.body.id })).body.number).toBe(
      `NOTE-${YYYY}-00002`,
    );
  });

  it('prints and tests the title, as the notes service passes it', async () => {
    await node
      .admin()
      .post('/v1/naming-series')
      .send({
        subject: 'Note',
        pattern: 'N-.{title}.-.##',
        conditions: [{ field: 'title', op: 'ne', value: 'Plain' }],
      })
      .expect(201);
    const note = (title: string) =>
      node
        .admin()
        .post('/v1/notes')
        .set('Idempotency-Key', randomUUID())
        .send({ title, body: 'Text' })
        .expect(201);
    expect((await note('Weekly sync')).body.number).toBe('N-Weekly-sync-01');
    expect((await note('Weekly sync')).body.number).toBe('N-Weekly-sync-02');
    // Plain: the condition fails, the default (this series, the first) numbers it all the same.
    expect((await note('Plain')).body.number).toBe('N-Plain-01');
  });

  it("refuses another subject's series", async () => {
    const memo = await node
      .admin()
      .post('/v1/naming-series')
      .send({ subject: 'Note', pattern: 'MEMO-.####' })
      .expect(201);
    const refused = await node
      .admin()
      .post('/v1/test-items')
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Numbered', namingSeriesId: memo.body.id })
      .expect(400);
    expect(refused.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'namingSeriesId',
    ]);
  });
});
