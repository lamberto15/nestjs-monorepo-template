import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  afterKeyset,
  sortOrder,
  sortSchema,
  type SortBy,
} from './list-sort.js';
import { notes } from '../../features/notes/notes.tables.js';
import { auditLog } from '../../iam/iam.tables.js';

const dialect = new PgDialect();

const indexExpression = (
  table: Parameters<typeof getTableConfig>[0],
  name: string,
) => {
  const expression = getTableConfig(table).indexes.find(
    (item) => item.config.name === name,
  )?.config.columns[1];
  if (!expression) throw new Error(`Missing index expression: ${name}`);
  return dialect.sqlToQuery(expression as SQL).sql;
};

describe('datetime list sorting', () => {
  it('uses an explicit UTC millisecond expression and keeps the declared null ordering', () => {
    const sort = sortSchema({
      createdAt: { column: notes.createdAt, type: 'datetime', sortable: true },
    }).parse('createdAt');
    const query = dialect.sqlToQuery(sortOrder(sort)[0]!);
    expect(query.sql).toContain("at time zone 'UTC'");
    expect(query.sql).toContain('asc nulls last');
  });

  it('uses the same timestamp expressions in list ordering and supporting indexes', () => {
    const noteSort = sortSchema({
      updatedAt: { column: notes.updatedAt, type: 'datetime', sortable: true },
    }).parse('-updatedAt');
    const auditSort = sortSchema({
      at: { column: auditLog.at, type: 'datetime', sortable: true },
    }).parse('-at');
    const noteRuntime = dialect.sqlToQuery(noteSort[0]!.expression as SQL).sql;
    const auditRuntime = dialect.sqlToQuery(
      auditSort[0]!.expression as SQL,
    ).sql;

    expect(indexExpression(notes, 'notes_tenant_updated_ms_idx')).toContain(
      noteRuntime,
    );
    expect(
      indexExpression(auditLog, 'audit_log_tenant_at_ms_id_idx'),
    ).toContain(auditRuntime);
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
