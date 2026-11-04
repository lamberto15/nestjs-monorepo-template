import { sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  afterKeyset,
  sortOrder,
  sortSchema,
  type SortBy,
} from './list-sort.js';
import type { FilterField } from './list-query.js';
import { auditLog, users } from '../../iam/iam.tables.js';

const dialect = new PgDialect();

describe('datetime list sorting', () => {
  it('sorts a datetime column as it is, keeping the declared null ordering', () => {
    const sort = sortSchema({
      at: { column: auditLog.at, type: 'datetime', sortable: true },
    }).parse('at');
    const query = dialect.sqlToQuery(sortOrder(sort)[0]!);
    expect(query.sql).toBe('"audit_log"."at" asc nulls last');
  });

  it('truncates a datetime SQL expression to the millisecond', () => {
    const sort = sortSchema({
      at: { column: sql`now()`, type: 'datetime', sortable: true },
    }).parse('at');
    const query = dialect.sqlToQuery(sortOrder(sort)[0]!);
    expect(query.sql).toContain("date_trunc('milliseconds'");
  });

  // An expression would be a filter under row-level security, not an index
  // bound: every page would rescan the rows before it.
  it('compares the plain columns in the keyset predicate, so an index can seek it', () => {
    const sort: SortBy[] = sortSchema({
      at: { column: auditLog.at, type: 'datetime', sortable: true },
    }).parse('-at');
    const query = dialect.sqlToQuery(
      afterKeyset(
        sort,
        [new Date('2026-10-01T00:00:00.123Z')],
        auditLog.id,
        '0199a000-0000-7000-8000-00000000000a',
      )!,
    );
    expect(query.sql).toContain('("audit_log"."at", "audit_log"."id") < (');
    expect(query.sql).not.toContain('date_trunc');
  });

  it('has a supporting index in the list order (desc nulls first, then the id)', () => {
    const columns = getTableConfig(auditLog).indexes.find(
      (item) => item.config.name === 'audit_log_tenant_at_id_idx',
    )?.config.columns as unknown as {
      name: string;
      indexConfig: { order: string; nulls: string };
    }[];
    expect(columns.map((column) => column.name)).toEqual([
      'tenant_id',
      'at',
      'id',
    ]);
    for (const column of columns.slice(1)) {
      expect(column.indexConfig.order).toBe('desc');
      expect(column.indexConfig.nulls).toBe('first');
    }
  });

  it('continues after nulls according to descending nulls-first order', () => {
    const sort: SortBy[] = [
      {
        name: 'at',
        key: 'at',
        expression: auditLog.at,
        type: 'datetime',
        desc: true,
        notNull: true,
      },
    ];
    const query = dialect.sqlToQuery(
      afterKeyset(
        sort,
        [null],
        auditLog.id,
        '0199a000-0000-7000-8000-00000000000a',
      )!,
    );
    expect(query.sql).toContain('is not null');
  });
});

describe('the keyset cursor shapes', () => {
  const id = '0199a000-0000-7000-8000-00000000000a';
  const fields = {
    at: { column: auditLog.at, type: 'datetime', sortable: true },
    published: {
      column: users.deprovisionedAt,
      type: 'datetime',
      sortable: true,
    },
    name: { column: sql`lower(x)`, type: 'string', sortable: true },
    size: { column: auditLog.id, type: 'number', sortable: true },
  } satisfies Record<string, FilterField>;
  const where = (text: string, after: unknown[]) =>
    dialect
      .sqlToQuery(
        afterKeyset(sortSchema(fields).parse(text), after, auditLog.id, id)!,
      )
      .sql.toLowerCase();
  const date = '2026-10-01T00:00:00.123Z';

  it('sets notNull from the Drizzle column only', () => {
    const [at, published, name] = sortSchema(fields).parse('at,published,name');
    expect([at!.notNull, published!.notNull, name!.notNull]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('is a row comparison when all fields are descending and none is NULL', () => {
    for (const text of ['-at', '-at,-size']) {
      const text2 = where(text, text === '-at' ? [date] : [date, 1]);
      expect(text2).toContain('"audit_log"."id") < (');
      expect(text2).not.toContain(' or ');
    }
  });

  it('keeps the exact OR, with no bound, past a NULL descending', () => {
    const text = where('-at', [null]);
    expect(text).not.toContain('"audit_log"."id") < (');
    expect(text).not.toContain('<=');
    expect(text).toContain(' or ');
  });

  it('bounds an ascending NOT NULL field with >=', () => {
    const text = where('at', [date]);
    expect(text).toContain('>= $1');
    expect(text).toContain(' or ');
  });

  it('bounds an ascending field past NULL with is null', () => {
    expect(where('at', [null])).toContain('is null');
  });

  it('has no bound on a nullable ascending field with a value', () => {
    expect(where('published', [date])).not.toContain('<=');
    expect(where('published', [date])).not.toContain('>= $');
  });

  it('bounds a mixed sort on its first field with <=', () => {
    const text = where('-at,size', [date, 1]);
    expect(text).toContain('<= $1');
    expect(text).toContain(' or ');
  });
});
