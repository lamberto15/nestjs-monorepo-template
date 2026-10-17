/**
 * The advanced list query (docs/api-conventions.md) through the notes route:
 * its own sortable fields (rank, number, status), redaction, OpenAPI. The
 * query itself is tested on a table of every type and on test items
 * (test/list-advanced.e2e-spec.ts).
 */
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

describe('the advanced list query on GET /v1/notes (e2e)', () => {
  let node: TestApp;
  let auth: string;
  const titles = ['Plan', 'Plan', 'Report', 'Plan', 'Memo', 'Report', 'Zeta'];
  const written: { id: string; title: string }[] = [];

  beforeAll(async () => {
    node = await bootApp();
    ({ auth } = await node.client());
    for (const title of titles) {
      const res = await writeNote(node, auth, { title, body: `${title} text` });
      expect(res.status).toBe(201);
      written.push({ id: res.body.id, title });
    }
  });
  afterAll(() => node.close());

  const list = (query: Record<string, string>, as = auth) =>
    node.http().get('/v1/notes').query(query).set('Authorization', as);

  it('filters with and / or trees, and counts what they match', async () => {
    const res = await list({
      count: 'true',
      filter: JSON.stringify({
        or: [
          { field: 'title', op: 'startsWith', value: 'rep' },
          { field: 'title', op: 'endsWith', value: 'eta' },
        ],
      }),
    }).expect(200);
    expect(
      res.body.items.map((n: { title: string }) => n.title).sort(),
    ).toEqual(['Report', 'Report', 'Zeta']);
    expect(res.body).toMatchObject({ total: 3, totalCapped: false });
  });

  it('never lets an or widen what the caller may see', async () => {
    // Another client: it may read its own notes only.
    const other = await node.client();
    await writeNote(node, other.auth, {
      title: 'Theirs',
      body: 'x',
    }).expect(201);
    const everything = JSON.stringify({
      or: [
        { field: 'title', op: 'contains', value: 'Plan' },
        { field: 'status', op: 'in', value: ['draft', 'published'] },
        { field: 'createdAt', op: 'gte', value: '2000-01-01T00:00:00Z' },
      ],
    });
    const res = await list(
      { filter: everything, count: 'true' },
      other.auth,
    ).expect(200);
    expect(res.body.items.map((n: { title: string }) => n.title)).toEqual([
      'Theirs',
    ]);
    expect(res.body.total).toBe(1);
    // Flat filters next to it change nothing either.
    const flat = await list(
      { filter: everything, 'status.in': 'draft,published' },
      other.auth,
    ).expect(200);
    expect(flat.body.items).toHaveLength(1);
  });

  it('walks a sort with ties page by page, with no note twice and none missed', async () => {
    const seen: { id: string; title: string }[] = [];
    let cursor: string | null = null;
    do {
      const res: {
        body: {
          items: { id: string; title: string }[];
          nextCursor: string | null;
        };
      } = await list({
        sort: 'title',
        limit: '2',
        ...(cursor && { cursor }),
      }).expect(200);
      seen.push(...res.body.items);
      cursor = res.body.nextCursor;
    } while (cursor);
    const expectedOrder = [...written].sort((a, b) =>
      a.title === b.title ? (a.id < b.id ? 1 : -1) : a.title < b.title ? -1 : 1,
    );
    expect(seen.map((n) => n.id)).toEqual(expectedOrder.map((n) => n.id));

    const descending = await list({
      sort: '-title,-createdAt',
      limit: '100',
    }).expect(200);
    expect(descending.body.items[0].title).toBe('Zeta');
  });

  it('pages by number with a page count', async () => {
    const res = await list({
      sort: '-createdAt',
      page: '2',
      limit: '3',
      count: 'true',
    }).expect(200);
    expect(res.body).toMatchObject({
      page: 2,
      nextPage: 3,
      nextCursor: null,
      total: titles.length,
      pageCount: 3,
    });
    expect(res.body.items.map((n: { id: string }) => n.id)).toEqual(
      [...written]
        .reverse()
        .slice(3, 6)
        .map((n) => n.id),
    );
  });

  it('answers with the fields asked for, id always, redaction still applied', async () => {
    const res = await list({ fields: 'title,status', limit: '1' }).expect(200);
    expect(Object.keys(res.body.items[0]).sort()).toEqual([
      'id',
      'status',
      'title',
    ]);

    // A reader whose permissions leave out the text asks for it: still left out.
    const role = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `Titles only ${Date.now()}`,
        permissions: [
          { subject: 'Note', action: 'read', conditions: [], fields: [] },
        ],
      })
      .expect(201);
    const reader = await node.user([role.body.id]);
    const asked = await reader.agent
      .get('/v1/notes')
      .query({ fields: 'title,body', limit: '5' })
      .expect(200);
    expect(asked.body.items.length).toBeGreaterThan(0);
    for (const item of asked.body.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'title']);
    }
  });

  it('answers a 400 naming what is wrong', async () => {
    const cases: [Record<string, string>, string][] = [
      [
        {
          filter: JSON.stringify({ field: 'body', op: 'contains', value: 'x' }),
        },
        'filter.field',
      ],
      [
        { filter: JSON.stringify({ field: 'title', op: 'eq', value: 'x' }) },
        'filter.op',
      ],
      [{ filter: '{nope' }, 'filter'],
      [{ sort: 'body' }, 'sort'],
      [{ fields: 'title,secret' }, 'fields'],
      [
        { sort: 'title', cursor: '01a13db4-cd54-7fff-9208-8159d0e51a30' },
        'cursor',
      ],
    ];
    for (const [query, path] of cases) {
      const res = await list(query).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(
        res.body.errors.map((e: { path: string }) => e.path),
        JSON.stringify(query),
      ).toEqual([path]);
    }
    const named = await list({
      filter: JSON.stringify({ field: 'body', op: 'eq', value: 'x' }),
    }).expect(400);
    expect(named.body.errors[0].message).toContain('"body"');
  });

  it('documents filter, sort and fields with examples', async () => {
    const document = (await node.http().get('/api-json').expect(200)).body;
    const params: { name: string; description?: string }[] =
      document.paths['/v1/notes'].get.parameters;
    const described = (name: string) =>
      params.find((param) => param.name === name)?.description ?? '';
    expect(described('filter')).toContain('Example:');
    expect(described('filter')).toContain('title (contains');
    expect(described('sort')).toContain(
      'Sortable: rank, number, status, title, createdAt, updatedAt, publishedAt',
    );
    expect(described('fields')).toContain('Example: ');
    expect(described('page')).toContain('Example:');
  });

  it('is described at GET /v1/lists/Note (a hand-written list registered with listSource)', async () => {
    const { body } = await node
      .http()
      .get('/v1/lists/Note')
      .set('Authorization', auth)
      .expect(200);
    expect(body).toMatchObject({ subject: 'Note', search: true });
    expect(
      body.fields.find((field: { name: string }) => field.name === 'status'),
    ).toEqual({
      name: 'status',
      type: 'enum',
      options: ['draft', 'published'],
      operators: ['eq', 'ne', 'in', 'notIn'],
      sortable: true,
      custom: false,
    });
  });
});
