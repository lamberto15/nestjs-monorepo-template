/**
 * The advanced list query (docs/api-conventions.md): `filter` (and/or
 * trees), `sort` with keyset cursors, `page` numbers and `fields`. First on
 * a table of every type in PostgreSQL (the SQL, against the same rows in
 * JavaScript), then through the test items route (access, redaction, OpenAPI).
 */
import type { Database } from '../src/core/database/drizzle.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { type ListQuery, listQuery } from '../src/core/http/list-query.js';
import {
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../src/core/http/pagination.js';
import { bootApp, type TestApp, testDatabase } from './support.js';

const things = pgTable('things', {
  id: uuid('id').primaryKey(),
  name: text('name'),
  kind: text('kind').notNull(),
  size: integer('size'),
  done: boolean('done').notNull(),
  at: timestamp('at', { withTimezone: true, mode: 'date' }),
});
/** The same table, written with microseconds (a Date has milliseconds only). */
const thingsWritten = pgTable('things', {
  id: uuid('id').primaryKey(),
  name: text('name'),
  kind: text('kind').notNull(),
  size: integer('size'),
  done: boolean('done').notNull(),
  at: timestamp('at', { withTimezone: true, mode: 'string' }),
});
type Thing = {
  id: string;
  name: string | null;
  kind: string;
  size: number | null;
  done: boolean;
  at: string | null;
};

const LIST = listQuery(
  {
    name: {
      column: things.name,
      type: 'string',
      ops: [
        'eq',
        'ne',
        'contains',
        'notContains',
        'startsWith',
        'endsWith',
        'isNull',
      ],
      sortable: true,
    },
    kind: {
      column: things.kind,
      type: 'enum',
      values: ['a', 'b', 'c'],
      ops: ['eq', 'ne', 'in', 'notIn'],
      sortable: true,
    },
    size: {
      column: things.size,
      type: 'number',
      ops: ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull'],
      sortable: true,
    },
    done: { column: things.done, type: 'boolean', ops: ['eq'], sortable: true },
    at: {
      column: things.at,
      type: 'datetime',
      ops: ['gte', 'lt', 'between', 'isNull'],
      sortable: true,
    },
    // An SQL expression, as a custom field inside JSONB would be.
    nameLength: {
      column: sql`length(${things.name})`,
      type: 'number',
      ops: ['gte'],
    },
  },
  { select: ['id', 'name', 'kind', 'size'] },
);

describe('the advanced list query (PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let db: Database;
  const rows: Thing[] = [];

  /** Every Nth row of a small set of values: ties and NULLs on every sort field. */
  beforeAll(async () => {
    database = await testDatabase();
    db = database.db;
    // A fixture table for this test only, not the app's schema: made by the
    // owner (the app role can't), usable by the app through the owner's
    // default privileges, as a table of a later migration is.
    await database.asOwner(`create table things (
      id uuid primary key, name text, kind text not null, size integer,
      done boolean not null, at timestamptz)`);
    const names = ['alpha', 'Beta', null, '50%_off', 'alphabet'];
    for (let i = 0; i < 37; i++) {
      // Microseconds in the timestamps: the cursor (milliseconds) must still be exact.
      const micro = String(i % 4).padStart(3, '0');
      rows.push({
        id: randomUUID(),
        name: names[i % names.length],
        kind: ['a', 'b', 'c'][i % 3],
        size: i % 6 === 0 ? null : i % 5,
        done: i % 2 === 0,
        at:
          i % 7 === 0
            ? null
            : `2026-01-0${(i % 3) + 1}T10:00:00.123${micro}+00:00`,
      });
    }
    await db.insert(thingsWritten).values(rows);
  });
  afterAll(() => database.close());

  const parse = (query: Record<string, string>) => LIST.schema.safeParse(query);
  const ok = (query: Record<string, string>) => {
    const parsed = parse(query);
    expect(parsed.error?.issues).toBeUndefined();
    return parsed.data as ListQuery;
  };
  const errors = (query: Record<string, string>) =>
    parse(query).error!.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
  const filter = (tree: unknown) => ({ filter: JSON.stringify(tree) });

  /** One page, as a service makes it. */
  async function page(query: ListQuery) {
    const fetched = await db
      .select()
      .from(things)
      .where(LIST.where(query, things.id))
      .orderBy(...pageOrder(things.id, query))
      .limit(query.limit + 1)
      .offset(pageOffset(query));
    return toPage(fetched as unknown as Thing[], query);
  }
  /** The ids a filter matches. */
  const ids = async (query: Record<string, string>) =>
    (await page(ok({ limit: '100', ...query }))).items
      .map((row) => row.id)
      .sort();
  const expected = (match: (row: Thing) => boolean) =>
    rows
      .filter(match)
      .map((row) => row.id)
      .sort();

  it('builds every operator, and matches what JavaScript matches', async () => {
    const cases: [unknown, (row: Thing) => boolean][] = [
      [{ field: 'name', op: 'eq', value: 'alpha' }, (r) => r.name === 'alpha'],
      [
        { field: 'name', op: 'ne', value: 'alpha' },
        (r) => r.name !== null && r.name !== 'alpha',
      ],
      [
        { field: 'name', op: 'contains', value: 'ALPHA' },
        (r) => !!r.name?.toLowerCase().includes('alpha'),
      ],
      [
        { field: 'name', op: 'notContains', value: 'alpha' },
        (r) => r.name !== null && !r.name.includes('alpha'),
      ],
      [
        { field: 'name', op: 'startsWith', value: 'b' },
        (r) => !!r.name?.toLowerCase().startsWith('b'),
      ],
      [
        { field: 'name', op: 'endsWith', value: 'bet' },
        (r) => !!r.name?.endsWith('bet'),
      ],
      // LIKE's wildcards are characters.
      [
        { field: 'name', op: 'contains', value: '%_' },
        (r) => r.name === '50%_off',
      ],
      [{ field: 'name', op: 'isNull', value: true }, (r) => r.name === null],
      [{ field: 'name', op: 'isNull', value: false }, (r) => r.name !== null],
      [{ field: 'name', op: 'isNull' }, (r) => r.name === null],
      [
        { field: 'kind', op: 'in', value: ['a', 'c'] },
        (r) => ['a', 'c'].includes(r.kind),
      ],
      [{ field: 'kind', op: 'notIn', value: ['a'] }, (r) => r.kind !== 'a'],
      [{ field: 'kind', op: 'ne', value: 'b' }, (r) => r.kind !== 'b'],
      [{ field: 'size', op: 'eq', value: 2 }, (r) => r.size === 2],
      [{ field: 'size', op: 'gt', value: 2 }, (r) => (r.size ?? -1) > 2],
      [
        { field: 'size', op: 'lte', value: 1 },
        (r) => r.size !== null && r.size <= 1,
      ],
      [
        { field: 'size', op: 'between', value: [1, 3] },
        (r) => r.size !== null && r.size >= 1 && r.size <= 3,
      ],
      [{ field: 'done', op: 'eq', value: false }, (r) => !r.done],
      [
        { field: 'at', op: 'gte', value: '2026-01-02T00:00:00Z' },
        (r) => r.at !== null && r.at >= '2026-01-02',
      ],
      [
        {
          field: 'at',
          op: 'between',
          value: ['2026-01-02T00:00:00+02:00', '2026-01-02T23:59:59Z'],
        },
        (r) => !!r.at?.startsWith('2026-01-02'),
      ],
      [
        { field: 'nameLength', op: 'gte', value: 8 },
        (r) => (r.name?.length ?? 0) >= 8,
      ],
    ];
    for (const [tree, match] of cases) {
      expect(await ids(filter(tree)), JSON.stringify(tree)).toEqual(
        expected(match),
      );
    }
    // The same operators in the flat syntax.
    expect(await ids({ 'kind.notIn': 'a,b' })).toEqual(
      expected((r) => r.kind === 'c'),
    );
    expect(await ids({ 'size.between': '1,3' })).toEqual(
      expected((r) => r.size !== null && r.size >= 1 && r.size <= 3),
    );
    expect(await ids({ 'name.endsWith': 'bet' })).toEqual(
      expected((r) => !!r.name?.endsWith('bet')),
    );
  });

  it('nests and / or groups, and ANDs them with the flat filters', async () => {
    const tree = {
      or: [
        { field: 'kind', op: 'eq', value: 'a' },
        {
          and: [
            { field: 'done', op: 'eq', value: true },
            { field: 'size', op: 'isNull', value: true },
          ],
        },
      ],
    };
    const match = (r: Thing) => r.kind === 'a' || (r.done && r.size === null);
    expect(await ids(filter(tree))).toEqual(expected(match));
    expect(await ids({ ...filter(tree), 'name.isNull': 'false' })).toEqual(
      expected((r) => match(r) && r.name !== null),
    );
    // A condition alone is a filter too.
    expect(await ids(filter({ field: 'kind', op: 'eq', value: 'b' }))).toEqual(
      expected((r) => r.kind === 'b'),
    );
  });

  it('refuses undeclared fields and operators, bad values and shapes, naming them', () => {
    expect(errors(filter({ field: 'secret', op: 'eq', value: 1 }))).toEqual([
      'filter.field: Not a filter of this list: "secret"',
    ]);
    expect(errors(filter({ field: 'done', op: 'in', value: [true] }))).toEqual([
      `filter.op: "done" can't be filtered with in`,
    ]);
    expect(
      errors(filter({ and: [{ field: 'kind', op: 'eq', value: 'z' }] }))[0],
    ).toMatch(/^filter\.and\.0\.value: kind eq/);
    for (const tree of [
      { field: 'size', op: 'gt', value: '2' }, // JSON: a number is a number
      { field: 'at', op: 'gte', value: '2026-01-01' }, // a date and time, with offset
      { field: 'at', op: 'gte', value: 1767225600000 }, // no epoch numbers
      { field: 'size', op: 'between', value: [1] },
      { field: 'kind', op: 'in', value: [] },
      { field: 'name', op: 'contains', value: '' },
      { field: 'name', op: 'like', value: 'x' }, // not an operator
      { field: 'name', op: 'eq', value: 'x', extra: 1 },
      { and: [] },
      { and: [{ field: 'kind', op: 'eq', value: 'a' }], or: [] },
      [{ field: 'kind', op: 'eq', value: 'a' }],
      'kind=a',
    ]) {
      expect(parse(filter(tree)).success, JSON.stringify(tree)).toBe(false);
    }
    expect(errors({ filter: '{"and":[' })).toEqual([
      'filter: filter is not JSON',
    ]);
  });

  it('bounds the depth and the number of conditions', () => {
    const leaf = { field: 'kind', op: 'eq', value: 'a' };
    const nested = (depth: number): unknown =>
      depth === 0 ? leaf : { and: [nested(depth - 1)] };
    expect(parse(filter(nested(3))).success).toBe(true);
    expect(errors(filter(nested(4))).join()).toContain('3 deep');
    expect(parse(filter({ or: Array(30).fill(leaf) })).success).toBe(true);
    expect(errors(filter({ or: Array(31).fill(leaf) }))).toEqual([
      'filter.or.30: at most 30 conditions',
    ]);
  });

  /** Walks every page of a sort by cursor; the rows, in order. */
  async function walk(query: Record<string, string>) {
    const seen: Thing[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result: { items: Thing[]; nextCursor: string | null } = await page(
        ok({ ...query, ...(cursor && { cursor }) }),
      );
      seen.push(...result.items);
      cursor = result.nextCursor;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    return seen;
  }

  /** The order a sort promises: by each field (NULLs the largest), then the newest id. */
  function sorted(fields: [keyof Thing, boolean][], from = rows) {
    const value = (row: Thing, key: keyof Thing) => {
      const v = row[key];
      // The cursor and the order go by the millisecond.
      return typeof v === 'string' && key === 'at' ? v.slice(0, 23) : v;
    };
    return [...from].sort((a, b) => {
      for (const [key, desc] of fields) {
        const [x, y] = [value(a, key), value(b, key)];
        if (x === y) {
          continue;
        }
        const order = x === null ? 1 : y === null ? -1 : x! < y! ? -1 : 1;
        return desc ? -order : order;
      }
      return a.id < b.id ? 1 : -1;
    });
  }

  it.each([
    ['name', [['name', false]]],
    ['-name', [['name', true]]],
    [
      'kind,-size',
      [
        ['kind', false],
        ['size', true],
      ],
    ],
    [
      '-done,at',
      [
        ['done', true],
        ['at', false],
      ],
    ],
    [
      '-at,name,size',
      [
        ['at', true],
        ['name', false],
        ['size', false],
      ],
    ],
  ] as [string, [keyof Thing, boolean][]][])(
    'walks every page of sort=%s with no row twice and none missed',
    async (sort, fields) => {
      for (const limit of ['1', '4', '7']) {
        const seen = await walk({ sort, limit });
        expect(
          seen.map((row) => row.id),
          `${sort} by ${limit}`,
        ).toEqual(sorted(fields).map((row) => row.id));
      }
    },
  );

  it('walks a sorted and filtered list, and counts it', async () => {
    const query = {
      sort: '-size',
      limit: '3',
      ...filter({
        or: [
          { field: 'kind', op: 'eq', value: 'a' },
          { field: 'size', op: 'isNull' },
        ],
      }),
    };
    const match = (r: Thing) => r.kind === 'a' || r.size === null;
    expect((await walk(query)).map((row) => row.id)).toEqual(
      sorted([['size', true]], rows.filter(match)).map((row) => row.id),
    );
    const parsed = ok({ ...query, count: 'true' });
    expect(
      await countPage(db as never, things, LIST.where(parsed), parsed),
    ).toEqual({ total: rows.filter(match).length, totalCapped: false });
  });

  it('pages by number, sorted or not', async () => {
    const all = sorted([['kind', false]]);
    const first = await page(ok({ sort: 'kind', page: '1', limit: '10' }));
    expect(first).toMatchObject({ page: 1, nextPage: 2, nextCursor: null });
    expect(first.items.map((row) => row.id)).toEqual(
      all.slice(0, 10).map((row) => row.id),
    );
    const last = await page(ok({ sort: 'kind', page: '4', limit: '10' }));
    expect(last).toMatchObject({ page: 4, nextPage: null });
    expect(last.items.map((row) => row.id)).toEqual(
      all.slice(30).map((row) => row.id),
    );
    expect(
      toPage([], ok({ page: '2', limit: '10' }), {
        total: 37,
        totalCapped: false,
      }),
    ).toMatchObject({ page: 2, pageCount: 4, total: 37 });
    // Not past the count's cap; not both a page and a cursor.
    expect(errors({ page: '101', limit: '100' })[0]).toMatch(/^page: /);
    expect(parse({ page: '100', limit: '100' }).success).toBe(true);
    expect(
      errors({ page: '1', cursor: '01a13db4-cd54-7fff-9208-8159d0e51a30' })[0],
    ).toMatch(/^cursor: /);
  });

  it('takes only the cursor of the same sort', async () => {
    const first = await page(ok({ sort: 'name', limit: '2' }));
    const cursor = first.nextCursor!;
    expect(parse({ sort: 'name', cursor }).success).toBe(true);
    for (const query of [
      { sort: '-name', cursor }, // another sort
      { cursor }, // no sort: an id
      { sort: 'name', cursor: first.items[1].id },
      { sort: 'name', cursor: 'garbage' },
      {
        sort: 'name',
        cursor: Buffer.from(
          JSON.stringify({ s: 'name', v: [{}], id: randomUUID() }),
        ).toString('base64url'),
      },
    ] as Record<string, string>[]) {
      expect(errors(query), JSON.stringify(query)).toEqual([
        'cursor: cursor is not the nextCursor of this list and sort',
      ]);
    }
  });

  it('sorts only by declared sortable fields, each once, three at most', () => {
    expect(errors({ sort: 'secret' })).toEqual([
      'sort: Not a sortable field of this list: "secret"',
    ]);
    expect(errors({ sort: 'nameLength' })[0]).toContain('"nameLength"');
    expect(errors({ sort: 'name,-name' })).toEqual([
      'sort: "name" is sorted twice',
    ]);
    expect(parse({ sort: 'name,kind,size,done' }).success).toBe(false);
    expect(parse({ sort: '' }).success).toBe(false);
    expect(ok({ sort: '-at, name' }).sort).toHaveLength(2);
  });

  it('picks the fields asked for, and id always', () => {
    const query = ok({ fields: 'kind, name,kind' });
    const picked = LIST.pick({ items: [rows[0]], nextCursor: null }, query);
    expect(picked.items).toEqual([
      { id: rows[0].id, name: rows[0].name, kind: rows[0].kind },
    ]);
    expect(LIST.pick({ items: [rows[0]] }, ok({})).items).toEqual([rows[0]]);
    expect(errors({ fields: 'name,done,secret' })).toEqual([
      'fields: Not a field of this list: done, secret',
    ]);
    expect(parse({ fields: ',' }).success).toBe(false);
  });

  it('extends a list with fields known at runtime', async () => {
    const EXTENDED = LIST.extend(
      {
        shout: {
          column: sql`upper(${things.name})`,
          type: 'string',
          ops: ['eq'],
        },
      },
      ['done'],
    );
    const query = EXTENDED.schema.parse({
      ...filter({ field: 'shout', op: 'eq', value: 'BETA' }),
      fields: 'done',
    }) as ListQuery;
    const found = await db.select().from(things).where(EXTENDED.where(query));
    expect(found.map((row) => row.id).sort()).toEqual(
      expected((r) => r.name === 'Beta'),
    );
    // The original list is unchanged.
    expect(
      parse(filter({ field: 'shout', op: 'eq', value: 'BETA' })).success,
    ).toBe(false);
  });
});

describe('the advanced list query on GET /v1/test-items (e2e)', () => {
  let node: TestApp;
  let auth: string;
  const titles = ['Plan', 'Plan', 'Report', 'Plan', 'Memo', 'Report', 'Zeta'];
  const written: { id: string; title: string }[] = [];

  beforeAll(async () => {
    node = await bootApp();
    ({ auth } = await node.client());
    for (const title of titles) {
      const res = await node.writeItem(auth, { title, body: `${title} text` });
      expect(res.status).toBe(201);
      written.push({ id: res.body.id, title });
    }
  });
  afterAll(() => node.close());

  const list = (query: Record<string, string>, as = auth) =>
    node.http().get('/v1/test-items').query(query).set('Authorization', as);

  it('filters with and / or trees, and counts what they match', async () => {
    const res = await list({
      count: 'true',
      filter: JSON.stringify({
        or: [
          { field: 'title', op: 'startsWith', value: 'rep' },
          { field: 'title', op: 'startsWith', value: 'Z' },
        ],
      }),
    }).expect(200);
    expect(
      res.body.items.map((n: { title: string }) => n.title).sort(),
    ).toEqual(['Report', 'Report', 'Zeta']);
    expect(res.body).toMatchObject({ total: 3, totalCapped: false });
  });

  it('never lets an or widen what the caller may see', async () => {
    // Another client: it may read its own items only.
    const other = await node.client();
    await node
      .writeItem(other.auth, { title: 'Theirs', body: 'x' })
      .expect(201);
    const everything = JSON.stringify({
      or: [
        { field: 'title', op: 'contains', value: 'Plan' },
        { field: 'title', op: 'startsWith', value: 'T' },
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
      { filter: everything, 'title.startsWith': 'T' },
      other.auth,
    ).expect(200);
    expect(flat.body.items).toHaveLength(1);
  });

  it('walks a sort with ties page by page, with no item twice and none missed', async () => {
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
    const res = await list({ fields: 'title,body', limit: '1' }).expect(200);
    expect(Object.keys(res.body.items[0]).sort()).toEqual([
      'body',
      'id',
      'title',
    ]);

    // A reader whose permissions leave out the text asks for it: still left out.
    const role = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `Titles only ${Date.now()}`,
        permissions: [
          { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
        ],
      })
      .expect(201);
    const reader = await node.user([role.body.id]);
    const asked = await reader.agent
      .get('/v1/test-items')
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
          filter: JSON.stringify({
            field: 'secret',
            op: 'contains',
            value: 'x',
          }),
        },
        'filter.field',
      ],
      [
        {
          filter: JSON.stringify({
            field: 'title',
            op: 'notContains',
            value: 'x',
          }),
        },
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
      filter: JSON.stringify({ field: 'secret', op: 'eq', value: 'x' }),
    }).expect(400);
    expect(named.body.errors[0].message).toContain('"secret"');
  });

  it('documents filter, sort and fields with examples', async () => {
    const document = (await node.http().get('/api-json').expect(200)).body;
    const params: { name: string; description?: string }[] =
      document.paths['/v1/test-items'].get.parameters;
    const described = (name: string) =>
      params.find((param) => param.name === name)?.description ?? '';
    expect(described('filter')).toContain('Example:');
    expect(described('filter')).toContain('title (eq, contains, startsWith');
    expect(described('sort')).toContain(
      'Sortable: rank, number, title, createdAt, updatedAt',
    );
    expect(described('fields')).toContain('Example: ');
    expect(described('page')).toContain('Example:');
  });
});
