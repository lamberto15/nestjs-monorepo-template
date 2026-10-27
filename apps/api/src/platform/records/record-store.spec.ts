import { sql, type SQL } from 'drizzle-orm';
import { PgDialect, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { List, ListQuery } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from './record.js';
import { RecordStore } from './record-store.js';

const items = pgTable('items', { id: uuid('id').primaryKey() });
/** With a recycle bin: `deletedAt`. */
const binned = pgTable('items', {
  id: uuid('id').primaryKey(),
  deletedAt: timestamp('deleted_at'),
});
const user = { kind: 'user', id: 'u1' } as Principal;

/** A RecordStore over a fake database that records the `where` of its page query. */
function setup() {
  const wheres: (SQL | undefined)[] = [];
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (condition: SQL | undefined) => {
      wheres.push(condition);
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
    offset: () => Promise.resolve([]),
  };
  const access = {
    sqlFilter: vi.fn(async () => sql`read_filter`),
  };
  const list = {
    where: vi.fn(() => sql`list_where`),
    sortSelect: vi.fn(() => ({})),
  };
  const store = new RecordStore(
    { subject: 'Item', softDelete: true } as RecordDeclaration,
    items as never,
    { tx: { select: () => chain } } as never,
    {} as never,
    {} as never,
    {} as never,
    { count: vi.fn() } as never,
    access as never,
  );
  const render = (condition: SQL | undefined) =>
    new PgDialect().sqlToQuery(condition!).sql;
  return { store, access, list, wheres, render };
}

/** The read filter and the list's filters compose inside the service (issue #706). */
describe('RecordStore.findPage', () => {
  it('ANDs the caller read filter with the list filters', async () => {
    const { store, access, list, wheres, render } = setup();
    const query = { limit: 10, count: false } as ListQuery;

    await store.findPage(user, list as unknown as List, query);

    expect(access.sqlFilter).toHaveBeenCalledWith(user, 'Item', 'read', {
      deleted: false,
    });
    expect(list.where).toHaveBeenCalledWith(query);
    expect(list.sortSelect).toHaveBeenCalledWith(query);
    expect(render(wheres[0])).toContain('read_filter');
    expect(render(wheres[0])).toContain('list_where');
  });

  it('reads the recycle bin with the restore permission', async () => {
    const { store, access, list } = setup();
    const query = { limit: 10, count: false, deleted: true } as ListQuery;

    await store.findPage(user, list as unknown as List, query);

    expect(access.sqlFilter).toHaveBeenCalledWith(user, 'Item', 'restore', {
      deleted: true,
    });
  });
});

/** A RecordStore whose single-record query finds `rows`, recording its `where`. */
function lookup(rows: unknown[]) {
  const wheres: (SQL | undefined)[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL | undefined) => {
          wheres.push(condition);
          return Promise.resolve(rows);
        },
      }),
    }),
  };
  const access = { sqlFilter: vi.fn(async () => sql`read_filter`) };
  const store = new RecordStore(
    { subject: 'Item', noun: 'item', softDelete: true } as RecordDeclaration,
    binned as never,
    { tx: db } as never,
    {} as never,
    {} as never,
    {} as never,
    { count: vi.fn() } as never,
    access as never,
  );
  const render = (condition: SQL | undefined) =>
    new PgDialect().sqlToQuery(condition!).sql;
  return { store, access, wheres, render };
}

/** A record the caller may not read is the 404 of a missing one (issue #772). */
describe('RecordStore.findOne', () => {
  it('filters by the read permission in the query with visibleTo', async () => {
    const { store, access, wheres, render } = lookup([{ id: 'r1' }]);

    await expect(
      store.findOne('r1', undefined, { visibleTo: user }),
    ).resolves.toEqual({ id: 'r1' });

    expect(access.sqlFilter).toHaveBeenCalledWith(user, 'Item', 'read', {
      deleted: false,
    });
    expect(render(wheres[0])).toContain('read_filter');
  });

  it('looks in the recycle bin with the restore permission', async () => {
    const { store, access } = lookup([{ id: 'r1' }]);

    await store.findOne('r1', undefined, { deleted: true, visibleTo: user });

    expect(access.sqlFilter).toHaveBeenCalledWith(user, 'Item', 'restore', {
      deleted: true,
    });
  });

  it('answers an unreadable record with the 404 of a missing one', async () => {
    const { store } = lookup([]);

    await expect(
      store.findOne('r1', undefined, { visibleTo: user }),
    ).rejects.toMatchObject({
      status: 404,
      message: 'Item r1 not found.',
    });
  });

  it('applies no permission filter without visibleTo (system work)', async () => {
    const { store, access, wheres, render } = lookup([{ id: 'r1' }]);

    await store.findOne('r1');

    expect(access.sqlFilter).not.toHaveBeenCalled();
    expect(render(wheres[0])).not.toContain('read_filter');
  });
});
