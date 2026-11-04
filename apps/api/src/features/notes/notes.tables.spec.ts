import { getTableConfig } from 'drizzle-orm/pg-core';
import { notes } from './notes.tables.js';

// The feature's own indexes, beside it: `pnpm feature:remove notes` takes
// this spec with the table (core's list-sort.spec.ts checks the audit log's).
const indexColumns = (name: string) =>
  (
    getTableConfig(notes).indexes.find((item) => item.config.name === name)
      ?.config.columns as unknown as { name: string }[] | undefined
  )?.map((column) => column.name);

describe('the notes table', () => {
  // The list sorts a datetime by the plain column (list-sort.ts), so a
  // keyset page seeks these instead of rescanning the rows before it.
  it.each([
    ['notes_tenant_created_at_idx', 'created_at'],
    ['notes_tenant_updated_at_idx', 'updated_at'],
    ['notes_tenant_published_at_id_idx', 'published_at'],
  ])('indexes the timestamp column the list sorts by (%s)', (name, column) => {
    expect(indexColumns(name)).toEqual(['tenant_id', column, 'id']);
  });
});
