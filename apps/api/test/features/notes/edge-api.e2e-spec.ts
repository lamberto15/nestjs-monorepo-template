/**
 * Edge cases of the notes list's own filters (the status, the publication
 * date); the conventions every list shares are tested on test items
 * (test/edge-api.e2e-spec.ts).
 */
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

describe('notes list filters, edge cases (e2e)', () => {
  let node: TestApp;
  let auth: string;
  const titles = [
    '100% done',
    '100x done',
    'a_b',
    'axb',
    'back\\slash',
    'backxslash',
  ];

  beforeAll(async () => {
    node = await bootApp();
    ({ auth } = await node.client());
    for (const title of titles) {
      await writeNote(node, auth, { title, body: 'x' }).expect(201);
    }
  });
  afterAll(() => node.close());

  const found = async (query: Record<string, string>) => {
    const res = await node
      .http()
      .get('/v1/notes')
      .query(query)
      .set('Authorization', auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.items as { title: string }[])
      .map((note) => note.title)
      .sort((a, b) => a.localeCompare(b));
  };

  it('reads `in` with spaces around the items, and refuses an empty list', async () => {
    expect(await found({ 'status.in': ' draft , published ' })).toHaveLength(
      titles.length,
    );
    expect(await found({ 'status.in': 'published,' })).toEqual([]);
    const empty = await node
      .http()
      .get('/v1/notes?status.in=,')
      .set('Authorization', auth)
      .expect(400);
    expect(empty.body.errors).toEqual([
      { path: 'status.in', message: expect.any(String) },
    ]);
    await node
      .http()
      .get('/v1/notes?status.in=draft,archived')
      .set('Authorization', auth)
      .expect(400);
  });

  it('reads isNull=false as "has a value"', async () => {
    expect(await found({ 'publishedAt.isNull': 'true' })).toHaveLength(
      titles.length,
    );
    expect(await found({ 'publishedAt.isNull': 'false' })).toEqual([]);
    expect(await found({ 'unitId.isNull': 'false' })).toEqual([]);
  });

  it('refuses undeclared operators on the status and the body, naming the key', async () => {
    for (const key of ['title', 'status.contains', 'body.contains']) {
      const res = await node
        .http()
        .get('/v1/notes')
        .query({ [key]: 'x' })
        .set('Authorization', auth)
        .expect(400);
      expect(JSON.stringify(res.body.errors), key).toContain(key);
    }
  });

  it('checks the status and the publication date by type', async () => {
    for (const [key, value] of [
      ['publishedAt.isNull', 'yes'],
      ['status', 'archived'],
    ]) {
      const res = await node
        .http()
        .get('/v1/notes')
        .query({ [key]: value })
        .set('Authorization', auth);
      expect(res.status, `${key}=${value}`).toBe(400);
      expect(res.body.errors[0].path).toBe(key);
    }
  });
});
