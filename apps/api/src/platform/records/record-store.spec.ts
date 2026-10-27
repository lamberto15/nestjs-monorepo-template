import { sql, type SQL } from 'drizzle-orm';
import { PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core';
import type { List, ListQuery } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from './record.js';
import { RecordStore } from './record-store.js';

const items = pgTable('items', { id: uuid('id').primaryKey() });
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
