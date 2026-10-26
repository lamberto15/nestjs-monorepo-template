import { PgDialect } from 'drizzle-orm/pg-core';
import {
  afterKeyset,
  sortOrder,
  sortSchema,
  type SortBy,
} from './list-sort.js';
import { notes } from '../../features/notes/notes.tables.js';

const dialect = new PgDialect();

describe('datetime list sorting', () => {
  it('uses an explicit UTC millisecond expression and keeps the declared null ordering', () => {
    const sort = sortSchema({
      createdAt: { column: notes.createdAt, type: 'datetime', sortable: true },
    }).parse('createdAt');
    const query = dialect.sqlToQuery(sortOrder(sort)[0]!);
    expect(query.sql).toContain("at time zone 'UTC'");
    expect(query.sql).toContain('asc nulls last');
  });

  it('keeps tied timestamps together in the keyset predicate before the id tie breaker', () => {
    const sort: SortBy[] = sortSchema({
      createdAt: { column: notes.createdAt, type: 'datetime', sortable: true },
    }).parse('-createdAt');
    const query = dialect.sqlToQuery(
      afterKeyset(
        sort,
        [new Date('2026-10-01T00:00:00.123Z')],
        notes.id,
        '0199a000-0000-7000-8000-00000000000a',
      )!,
    );
    expect(query.sql).toContain('date_trunc');
    expect(query.sql).toContain('"notes"."id" <');
  });

  it('continues after nulls according to descending nulls-first order', () => {
    const sort: SortBy[] = [
      {
        name: 'publishedAt',
        key: 'publishedAt',
        expression: notes.publishedAt,
        type: 'datetime',
        desc: true,
      },
    ];
    const query = dialect.sqlToQuery(
      afterKeyset(
        sort,
        [null],
        notes.id,
        '0199a000-0000-7000-8000-00000000000a',
      )!,
    );
    expect(query.sql).toContain('is not null');
  });
});
