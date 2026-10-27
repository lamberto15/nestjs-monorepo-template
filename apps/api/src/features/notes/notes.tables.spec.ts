import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { sortSchema } from '../../core/http/list-sort.js';
import { notes } from './notes.tables.js';

// The feature's own index, beside it: `pnpm feature:remove notes` takes this
// spec with the table (core's list-sort.spec.ts checks the audit log's).
const dialect = new PgDialect();

describe('the notes table', () => {
  it('indexes the timestamp expression the list sorts by', () => {
    const [sort] = sortSchema({
      updatedAt: { column: notes.updatedAt, type: 'datetime', sortable: true },
    }).parse('-updatedAt');
    const runtime = dialect.sqlToQuery(sort!.expression as SQL).sql;
    const index = getTableConfig(notes).indexes.find(
      (item) => item.config.name === 'notes_tenant_updated_ms_idx',
    );
    expect(index).toBeDefined();
    expect(dialect.sqlToQuery(index!.config.columns[1] as SQL).sql).toContain(
      runtime,
    );
  });

  it('indexes the published timestamp expression the list sorts by', () => {
    const [sort] = sortSchema({
      publishedAt: {
        column: notes.publishedAt,
        type: 'datetime',
        sortable: true,
      },
    }).parse('-publishedAt');
    const runtime = dialect.sqlToQuery(sort!.expression as SQL).sql;
    const index = getTableConfig(notes).indexes.find(
      (item) => item.config.name === 'notes_tenant_published_ms_idx',
    );
    expect(index).toBeDefined();
    expect(dialect.sqlToQuery(index!.config.columns[1] as SQL).sql).toContain(
      runtime,
    );
  });
});
