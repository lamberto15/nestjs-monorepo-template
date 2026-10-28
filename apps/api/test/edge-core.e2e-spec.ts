/**
 * Edge cases of the core building blocks a feature relies on without
 * reading them: the closure tree (on a database of its own), the list query
 * (filters and pagination, down to the SQL they make) and the problem
 * details filter. No application is booted here.
 */
import { testDatabase, testTenant } from './support.js';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  PgDialect,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { DrizzleQueryError } from 'drizzle-orm';
import { refusals } from '../src/core/database/database-errors.js';
import type { Database, Transaction } from '../src/core/database/drizzle.js';
import { Tree, TreeCycleError } from '../src/core/database/tree.js';
import { listQuery, type ListQuery } from '../src/core/http/list-query.js';
import { countPage, toPage } from '../src/core/http/pagination.js';
import {
  ProblemDetailsFilter,
  validationException,
} from '../src/core/http/problem-details.filter.js';
import {
  organizationalUnitClosure,
  organizationalUnits,
} from '../src/iam/iam.tables.js';

describe('Tree: a closure table (PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let db: Database;
  const tree = new Tree(organizationalUnitClosure);
  /** The parent of each node, as the test moved them: the truth to compare the closure with. */
  const parents = new Map<string, string | null>();

  const { scoped, create } = testTenant();

  beforeAll(async () => {
    database = await testDatabase();
    db = database.db;
    await create(db);
  });
  afterAll(() => database.close());
  beforeEach(
    scoped(async () => {
      parents.clear();
      await db.delete(organizationalUnits);
    }),
  );

  async function node(name: string, parentId: string | null = null) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(organizationalUnits)
        .values({ name, parentId })
        .returning({ id: organizationalUnits.id });
      await tree.add(tx, row.id, parentId);
      parents.set(row.id, parentId);
      return row.id;
    });
  }

  async function move(id: string, parentId: string | null) {
    await db.transaction((tx: Transaction) => tree.move(tx, id, parentId));
    parents.set(id, parentId);
  }

  const under = async (id: string) =>
    (
      await db
        .select({ id: organizationalUnits.id })
        .from(organizationalUnits)
        .where(inArray(organizationalUnits.id, tree.descendants(id)))
    )
      .map((row) => row.id)
      .sort((a, b) => a.localeCompare(b));

  const above = async (id: string) =>
    (
      await db
        .select({ id: organizationalUnits.id })
        .from(organizationalUnits)
        .where(inArray(organizationalUnits.id, tree.ancestors(id)))
    )
      .map((row) => row.id)
      .sort((a, b) => a.localeCompare(b));

  /** Every (ancestor, descendant, depth) the parents imply. */
  function expectedClosure() {
    const rows: string[] = [];
    for (const id of parents.keys()) {
      let current: string | null = id;
      let depth = 0;
      while (current) {
        rows.push(`${current}>${id}@${depth}`);
        current = parents.get(current) ?? null;
        depth++;
      }
    }
    return rows.sort((a, b) => a.localeCompare(b));
  }

  const actualClosure = async () =>
    (
      await db
        .select()
        .from(organizationalUnitClosure)
        .orderBy(asc(organizationalUnitClosure.ancestorId))
    )
      .map((row) => `${row.ancestorId}>${row.descendantId}@${row.depth}`)
      .sort((a, b) => a.localeCompare(b));

  it(
    'keeps every path of a deep chain, at the right depth',
    scoped(async () => {
      const chain: string[] = [];
      for (let i = 0; i < 12; i++) {
        chain.push(await node(`level ${i}`, chain.at(-1) ?? null));
      }
      expect(await actualClosure()).toEqual(expectedClosure());
      expect(await under(chain[0])).toEqual(
        [...chain].sort((a, b) => a.localeCompare(b)),
      );
      expect(await above(chain[11])).toEqual(
        [...chain].sort((a, b) => a.localeCompare(b)),
      );
      expect(await under(chain[11])).toEqual([chain[11]]);
      const [deepest] = await db
        .select({ depth: organizationalUnitClosure.depth })
        .from(organizationalUnitClosure)
        .where(eq(organizationalUnitClosure.descendantId, chain[11]))
        .orderBy(asc(organizationalUnitClosure.depth))
        .offset(11);
      expect(deepest.depth).toBe(11);
      expect(await tree.isUnder(db, chain[11], chain[0])).toBe(true);
      expect(await tree.isUnder(db, chain[0], chain[11])).toBe(false);
      // A node is "under" itself (depth 0).
      expect(await tree.isUnder(db, chain[5], chain[5])).toBe(true);
    }),
  );

  it(
    'moves a subtree to the root, keeping its inner paths',
    scoped(async () => {
      const root = await node('root');
      const a = await node('a', root);
      const b = await node('b', a);
      const c = await node('c', b);
      await move(a, null);
      expect(await actualClosure()).toEqual(expectedClosure());
      expect(await under(root)).toEqual([root]);
      expect(await under(a)).toEqual(
        [a, b, c].sort((a, b) => a.localeCompare(b)),
      );
      expect(await above(c)).toEqual(
        [a, b, c].sort((a, b) => a.localeCompare(b)),
      );
      // Moving a root to the root changes nothing.
      await move(a, null);
      expect(await actualClosure()).toEqual(expectedClosure());
    }),
  );

  it(
    "moves a subtree under a sibling's descendant",
    scoped(async () => {
      const root = await node('root');
      const left = await node('left', root);
      const leftChild = await node('left child', left);
      const right = await node('right', root);
      const rightChild = await node('right child', right);
      const rightGrandchild = await node('right grandchild', rightChild);
      await move(left, rightGrandchild);
      expect(await actualClosure()).toEqual(expectedClosure());
      expect(await above(leftChild)).toEqual(
        [root, right, rightChild, rightGrandchild, left, leftChild].sort(
          (a, b) => a.localeCompare(b),
        ),
      );
      expect(await under(right)).toEqual(
        [right, rightChild, rightGrandchild, left, leftChild].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
      const [path] = await db
        .select({ depth: organizationalUnitClosure.depth })
        .from(organizationalUnitClosure)
        .where(
          and(
            eq(organizationalUnitClosure.ancestorId, root),
            eq(organizationalUnitClosure.descendantId, leftChild),
          ),
        );
      expect(path.depth).toBe(5);
    }),
  );

  it(
    'moves a node under the parent it already has without changing a path',
    scoped(async () => {
      const root = await node('root');
      const a = await node('a', root);
      const b = await node('b', a);
      const before = await actualClosure();
      await move(a, root);
      expect(await actualClosure()).toEqual(before);
      expect(await under(root)).toEqual(
        [root, a, b].sort((a, b) => a.localeCompare(b)),
      );
    }),
  );

  it(
    'refuses a cycle: under itself or under one of its descendants, and changes nothing',
    scoped(async () => {
      const root = await node('root');
      const a = await node('a', root);
      const b = await node('b', a);
      const c = await node('c', b);
      const before = await actualClosure();
      await expect(move(a, a)).rejects.toBeInstanceOf(TreeCycleError);
      await expect(move(a, c)).rejects.toBeInstanceOf(TreeCycleError);
      await expect(move(root, b)).rejects.toBeInstanceOf(TreeCycleError);
      expect(await actualClosure()).toEqual(before);
      // The refused moves left the bookkeeping as it was.
      parents.set(a, root);
      parents.set(root, null);
      expect(await actualClosure()).toEqual(expectedClosure());
    }),
  );

  it(
    'stays consistent after many moves, and lookups follow each move',
    scoped(async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        // A small forest: each node under one of the earlier ones, or a root.
        const parent = i === 0 || i % 4 === 0 ? null : ids[(i * 7) % i];
        ids.push(await node(`n${i}`, parent));
      }
      // A fixed pseudo-random sequence of moves: same run every time.
      let seed = 42;
      const next = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed % n;
      };
      let moved = 0;
      let refused = 0;
      for (let step = 0; step < 40; step++) {
        const id = ids[next(ids.length)];
        const target = next(ids.length + 2);
        const parent = target >= ids.length ? null : ids[target];
        // A cycle exactly when the new parent is the node or below it.
        let cycle = false;
        for (let p: string | null = parent; p; p = parents.get(p) ?? null) {
          if (p === id) {
            cycle = true;
          }
        }
        if (cycle) {
          await expect(move(id, parent)).rejects.toBeInstanceOf(TreeCycleError);
          refused++;
        } else {
          await move(id, parent);
          moved++;
        }
        expect(await actualClosure()).toEqual(expectedClosure());
      }
      expect(moved).toBeGreaterThan(10);
      expect(refused).toBeGreaterThan(0);
      // descendants() of several roots at once, and of an SQL subquery.
      const roots = ids.filter((id) => !parents.get(id));
      expect(
        (
          await db
            .select({ id: organizationalUnits.id })
            .from(organizationalUnits)
            .where(inArray(organizationalUnits.id, tree.descendants(roots)))
        ).length,
      ).toBe(ids.length);
    }),
  );

  it(
    'forgets the paths of a deleted leaf (cascade)',
    scoped(async () => {
      const root = await node('root');
      const leaf = await node('leaf', root);
      await db
        .delete(organizationalUnits)
        .where(eq(organizationalUnits.id, leaf));
      parents.delete(leaf);
      expect(await actualClosure()).toEqual(expectedClosure());
      expect(await under(root)).toEqual([root]);
    }),
  );
});

describe('listQuery: filters and pagination', () => {
  const things = pgTable('things', {
    id: uuid('id').primaryKey(),
    name: text('name'),
    kind: text('kind'),
    ref: uuid('ref'),
    at: timestamp('at', { withTimezone: true }),
    size: integer('size'),
    done: boolean('done'),
  });
  const LIST = listQuery({
    name: {
      column: things.name,
      type: 'string',
      ops: ['eq', 'ne', 'contains', 'startsWith', 'isNull'],
    },
    kind: {
      column: things.kind,
      type: 'enum',
      values: ['a', 'b', 'c'],
      ops: ['eq', 'in'],
    },
    ref: { column: things.ref, type: 'uuid', ops: ['eq', 'in'] },
    at: {
      column: things.at,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte'],
    },
    size: { column: things.size, type: 'number', ops: ['gt', 'lte'] },
    done: { column: things.done, type: 'boolean', ops: ['eq'] },
  });
  const dialect = new PgDialect();
  const parse = (query: Record<string, string>) => LIST.schema.safeParse(query);
  const ok = (query: Record<string, string>) => {
    const parsed = parse(query);
    expect(parsed.error?.issues).toBeUndefined();
    return parsed.data as ListQuery;
  };
  const toSql = (query: Record<string, string>) => {
    const where = LIST.where(ok(query), things.id);
    return where ? dialect.sqlToQuery(where) : undefined;
  };
  const issueKeys = (query: Record<string, string>) =>
    parse(query).error!.issues.map((issue) =>
      issue.path.length ? issue.path.join('.') : issue.message,
    );

  it('defaults the limit to 50 and bounds it to 1..100', () => {
    expect(ok({}).limit).toBe(50);
    expect(ok({ limit: '1' }).limit).toBe(1);
    expect(ok({ limit: '100' }).limit).toBe(100);
    for (const limit of ['0', '101', '-1', '2.5', 'abc', '']) {
      expect(parse({ limit }).success, `limit=${limit}`).toBe(false);
    }
  });

  it('takes only a UUID as the cursor, and turns it into id < cursor', () => {
    expect(parse({ cursor: 'abc' }).success).toBe(false);
    expect(parse({ cursor: '1' }).success).toBe(false);
    const cursor = '01a13db4-cd54-7fff-9208-8159d0e51a30';
    const query = toSql({ cursor })!;
    expect(query.sql).toBe('"things"."id" < $1');
    expect(query.params).toEqual([cursor]);
    expect(toSql({})).toBeUndefined();
  });

  it('builds every operator, and no condition for absent keys', () => {
    const ref = '01a13db4-cd54-7fff-9208-8159d0e51a30';
    const query = toSql({
      name: 'x',
      'name.ne': 'y',
      'kind.in': 'a,b',
      ref,
      'at.gt': '2026-01-01T00:00:00Z',
      'at.gte': '2026-01-01T00:00:00+02:00',
      'at.lt': '2026-02-01T00:00:00Z',
      'at.lte': '2026-02-01T00:00:00Z',
      'size.gt': '3',
      'size.lte': '10',
      done: 'false',
    })!;
    expect(query.sql).toContain('"things"."name" = $1');
    expect(query.sql).toContain('"things"."name" <> $2');
    expect(query.sql).toContain('"things"."kind" in ($3, $4)');
    expect(query.sql).toMatch(/"things"\."at" > \$\d/);
    expect(query.sql).toMatch(/"things"\."at" >= \$\d/);
    expect(query.sql).toMatch(/"things"\."at" < \$\d/);
    expect(query.sql).toMatch(/"things"\."at" <= \$\d/);
    expect(query.sql).toMatch(/"things"\."size" > \$\d/);
    expect(query.sql).toMatch(/"things"\."done" = \$\d/);
    expect(query.params).toContain(3);
    expect(query.params).toContain(10);
    expect(query.params).toContain(false);
    // A time with an offset is the same instant in UTC.
    expect(query.params).toContain('2025-12-31T22:00:00.000Z');
  });

  it('splits `in` on commas, trims, drops empty items, and needs at least one', () => {
    expect(ok({ 'kind.in': ' a , b ,,c, ' })['kind.in']).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ok({ 'kind.in': 'a' })['kind.in']).toEqual(['a']);
    expect(issueKeys({ 'kind.in': ',' })).toEqual(['kind.in']);
    expect(issueKeys({ 'kind.in': ' , ' })).toEqual(['kind.in']);
    expect(parse({ 'kind.in': '' }).success).toBe(false);
    // Each item is checked by the field's type.
    expect(parse({ 'kind.in': 'a,z' }).success).toBe(false);
    expect(parse({ 'ref.in': 'not-a-uuid' }).success).toBe(false);
    expect(
      parse({ 'kind.in': Array.from({ length: 51 }, () => 'a').join(',') })
        .success,
    ).toBe(false);
  });

  it('reads isNull=true as IS NULL and isNull=false as IS NOT NULL, nothing else', () => {
    expect(toSql({ 'name.isNull': 'true' })!.sql).toBe(
      '"things"."name" is null',
    );
    expect(toSql({ 'name.isNull': 'false' })!.sql).toBe(
      '"things"."name" is not null',
    );
    for (const value of ['1', '0', 'yes', 'TRUE', '']) {
      expect(parse({ 'name.isNull': value }).success, value).toBe(false);
    }
  });

  it('checks values by type', () => {
    expect(parse({ ref: 'nope' }).success).toBe(false);
    expect(parse({ kind: 'z' }).success).toBe(false);
    expect(parse({ done: 'yes' }).success).toBe(false);
    expect(parse({ 'at.gte': '2026-01-01' }).success).toBe(false);
    expect(parse({ 'at.gte': 'yesterday' }).success).toBe(false);
    expect(parse({ 'size.gt': 'many' }).success).toBe(false);
    expect(parse({ name: '' }).success).toBe(false);
    expect(parse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(parse({ 'name.contains': '' }).success).toBe(false);
  });

  it('refuses undeclared fields and operators, naming the key; lang is allowed', () => {
    expect(issueKeys({ secret: '1' }).join()).toContain('secret');
    // An operator the field doesn't declare.
    expect(issueKeys({ 'done.in': 'true' }).join()).toContain('done.in');
    expect(issueKeys({ 'name.gt': 'a' }).join()).toContain('name.gt');
    expect(issueKeys({ 'kind.contains': 'a' }).join()).toContain(
      'kind.contains',
    );
    expect(ok({ lang: 'de' }).lang).toBe('de');
    expect(parse({ lang: 'x'.repeat(36) }).success).toBe(false);
  });

  it('escapes %, _ and backslash in contains and startsWith', () => {
    const contains = toSql({ 'name.contains': '50%_off\\now' })!;
    expect(contains.sql).toBe('"things"."name" ilike $1');
    expect(contains.params).toEqual(['%50\\%\\_off\\\\now%']);
    const startsWith = toSql({ 'name.startsWith': '%' })!;
    expect(startsWith.params).toEqual(['\\%%']);
  });

  it('adds a total to the page when one is given', () => {
    expect(
      toPage([{ id: 'a' }], { limit: 2 }, { total: 7, totalCapped: false }),
    ).toEqual({
      items: [{ id: 'a' }],
      nextCursor: null,
      total: 7,
      totalCapped: false,
    });
  });

  it('pages rows fetched with limit + 1', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));
    expect(toPage(rows(3), { limit: 2 })).toEqual({
      items: rows(2),
      nextCursor: 'id-1',
    });
    // Exactly `limit` rows: the end.
    expect(toPage(rows(2), { limit: 2 })).toEqual({
      items: rows(2),
      nextCursor: null,
    });
    expect(toPage([], { limit: 2 })).toEqual({ items: [], nextCursor: null });
  });
});

describe('ProblemDetailsFilter', () => {
  beforeAll(() => Logger.overrideLogger(false));

  /** Runs the filter on `exception` for an HTTP request; returns what it answered. */
  function answer(exception: unknown, request?: Record<string, unknown>) {
    const req = request ?? {
      originalUrl: '/v1/things?secret=1',
      headers: { 'x-request-id': 'req-unit-0001' },
    };
    const replies: { body: Record<string, unknown>; status: number }[] = [];
    const headers: Record<string, string> = {};
    const filter = new ProblemDetailsFilter({
      httpAdapter: {
        setHeader: (_res: unknown, name: string, value: string) =>
          (headers[name] = value),
        reply: (_res: unknown, body: Record<string, unknown>, status: number) =>
          replies.push({ body, status }),
      },
    } as never);
    filter.catch(exception, {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
    } as never);
    expect(headers['Content-Type']).toBe(
      'application/problem+json; charset=utf-8',
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].status).toBe(replies[0].body.status);
    return replies[0].body;
  }

  it('answers an exhausted pool and a statement timeout with 503 and Retry-After', () => {
    // The errors as node-postgres and Drizzle really throw them (checked on PostgreSQL 18).
    const busy = new DrizzleQueryError(
      'select 1',
      [],
      new Error('timeout exceeded when trying to connect'),
    );
    const before = refusals.busy;
    expect(answer(busy)).toMatchObject({
      status: 503,
      code: 'database_busy',
      retryAfter: 1,
    });
    expect(refusals.busy).toBe(before + 1);
    const slow = new DrizzleQueryError(
      'select pg_sleep(60)',
      [],
      Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    );
    const body = answer(slow);
    expect(body).toMatchObject({ status: 503, code: 'database_timeout' });
    // Neither the query nor the driver's text reaches the client.
    expect(JSON.stringify(body)).not.toMatch(/pg_sleep|canceling/);
    // Any other database error stays a plain 500.
    expect(
      answer(new DrizzleQueryError('select x', [], new Error('syntax error')))
        .status,
    ).toBe(500);
  });

  it('keeps a 503 whose body has a `status` of its own (GET /health when PostgreSQL or Redis is down)', () => {
    // What @nestjs/terminus throws: its `status: 'error'` once replaced the
    // 503, and Express answered 500; its failing indicators were dropped.
    const down = new ServiceUnavailableException({
      status: 'error',
      info: { database: { status: 'up' } },
      error: { redis: { status: 'down', message: 'timeout' } },
      details: {
        database: { status: 'up' },
        redis: { status: 'down', message: 'timeout' },
      },
    });
    const body = answer(down);
    expect(body).toMatchObject({
      status: 503,
      code: 'unavailable',
      error: { redis: { status: 'down', message: 'timeout' } },
      details: { redis: { status: 'down' } },
    });
    // Nest's own `error` (the status's name) stays out: `title` says it.
    expect(answer(new ConflictException('Taken')).error).toBeUndefined();
  });

  it('never shows the internals of an unexpected error', () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.5:5432 (user=app)');
    const body = answer(error);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'Something went wrong on our side.',
      code: 'internal_error',
      instance: '/v1/things',
      requestId: 'req-unit-0001',
    });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    // Not even when what was thrown isn't an Error.
    expect(answer('a string').status).toBe(500);
    expect(answer(undefined).status).toBe(500);
    expect(answer({ message: 'leak', status: 418 }).detail).toBe(
      'Something went wrong on our side.',
    );
  });

  it('keeps the code and extensions an exception carries', () => {
    expect(
      answer(
        new ConflictException({
          code: 'note_published',
          message: 'Published notes are final.',
          noteId: 'n1',
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'note_published',
      detail: 'Published notes are final.',
      noteId: 'n1',
    });
    // A package's `errorCode` serves as the code.
    expect(
      answer(new HttpException({ errorCode: 'E_X', message: 'm' }, 422)).code,
    ).toBe('E_X');
    // A string body is the detail; the status names the code.
    expect(answer(new HttpException('Teapot', 418))).toMatchObject({
      detail: 'Teapot',
      code: 'http_418',
      title: "I'm a Teapot",
    });
    expect(answer(new HttpException('Gone', HttpStatus.GONE)).code).toBe(
      'gone',
    );
  });

  it("turns Nest's list of messages into field errors", () => {
    expect(
      answer(new BadRequestException(['a is bad', 'b is bad'])),
    ).toMatchObject({
      detail: 'Bad Request',
      errors: [
        { path: '', message: 'a is bad' },
        { path: '', message: 'b is bad' },
      ],
    });
  });

  it('gives each validation issue its dotted path, array indexes and keys included', () => {
    const body = answer(
      validationException([
        { message: 'm1', path: ['items', 0, 'quantity'] },
        {
          message: 'm2',
          path: [{ key: 'address' }, { key: 'lines' }, { key: 2 }],
        },
        { message: 'm3' },
      ]),
    );
    expect(body.errors).toEqual([
      { path: 'items.0.quantity', message: 'm1' },
      { path: 'address.lines.2', message: 'm2' },
      { path: '', message: 'm3' },
    ]);
    expect(body.code).toBe('validation_failed');
  });

  it('maps a registered error type, and leaves others as a 500', () => {
    class OutOfStock extends Error {}
    class Unmapped extends Error {}
    ProblemDetailsFilter.map(
      OutOfStock,
      (error) =>
        new ConflictException({ code: 'out_of_stock', message: error.message }),
    );
    expect(answer(new OutOfStock('No more cats.'))).toMatchObject({
      status: 409,
      code: 'out_of_stock',
      detail: 'No more cats.',
    });
    expect(answer(new Unmapped('internal')).status).toBe(500);
  });
});

describe('countPage (PostgreSQL)', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let db: Database;
  const { scoped, create } = testTenant();

  beforeAll(async () => {
    database = await testDatabase();
    db = database.db;
    await create(db);
    await scoped(() =>
      db
        .insert(organizationalUnits)
        .values(['A', 'B', 'C', 'D', 'E'].map((name) => ({ name }))),
    )();
  });
  afterAll(() => database.close());

  it(
    'counts only when asked',
    scoped(async () => {
      expect(
        await countPage(db, organizationalUnits, undefined, { limit: 10 }),
      ).toBeUndefined();
      expect(
        await countPage(db, organizationalUnits, undefined, {
          limit: 10,
          count: false,
        }),
      ).toBeUndefined();
    }),
  );

  it(
    'counts what matches, up to the cap',
    scoped(async () => {
      const query = { limit: 10, count: true };
      expect(
        await countPage(db, organizationalUnits, undefined, query),
      ).toEqual({
        total: 5,
        totalCapped: false,
      });
      expect(
        await countPage(
          db,
          organizationalUnits,
          inArray(organizationalUnits.name, ['A', 'B']),
          query,
        ),
      ).toEqual({ total: 2, totalCapped: false });
      // Exactly the cap: still exact. One more: capped.
      expect(
        await countPage(db, organizationalUnits, undefined, query, 5),
      ).toEqual({
        total: 5,
        totalCapped: false,
      });
      expect(
        await countPage(db, organizationalUnits, undefined, query, 3),
      ).toEqual({
        total: 3,
        totalCapped: true,
      });
    }),
  );
});
