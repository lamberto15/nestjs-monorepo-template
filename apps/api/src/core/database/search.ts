import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, customType } from 'drizzle-orm/pg-core';
import type { FilterField } from '../http/list-query.js';

/**
 * Full-text search with PostgreSQL's own: a `tsvector` column generated
 * from the record's text, a GIN index, and `websearch_to_tsquery` for
 * what people type (`fast "dark mode" -legacy`). The `simple`
 * configuration: every language, no stemming (a template can't know the
 * language of its data; switch to `english`… per feature if it does).
 *
 * ```ts
 * // the table
 * search: searchVector('search', (): SQL => sql`${notes.title} || ' ' || ${notes.body}`),
 * (table) => [index('notes_search_idx').using('gin', table.search)]
 * // the list: ?q=… filters, ?sort=-rank orders the best first
 * export const NOTE_LIST = listQuery({ ...searchFields(notes.search), … });
 * ```
 */

const CONFIG = 'simple';

/** The column type: a text search vector. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * A search vector kept by the database from `text` (an expression of the
 * row's columns, given lazily so it may name the table being declared).
 */
export const searchVector = (name: string, text: () => SQL) =>
  tsvector(name).generatedAlwaysAs(
    (): SQL =>
      sql`to_tsvector(${sql.raw(`'${CONFIG}'`)}, coalesce(${text()}, ''))`,
  );

/** What people typed, as a query: words, "phrases", -exclusions, or. */
export const searchQuery = (q: string) =>
  sql`websearch_to_tsquery(${sql.raw(`'${CONFIG}'`)}, ${q})`;

/** The rows whose vector matches `q`. */
export const matches = (vector: AnyColumn | SQL, q: string) =>
  sql`${vector} @@ ${searchQuery(q)}`;

/** How well a row matches `q`: 0 to 1, more is better. */
export const rank = (vector: AnyColumn | SQL, q: string) =>
  sql<number>`ts_rank(${vector}, ${searchQuery(q)})`;

/** A snippet of `text` around the matches of `q`, the matches in <b>…</b>. */
export const headline = (text: AnyColumn | SQL, q: string) =>
  sql<string>`ts_headline(${sql.raw(`'${CONFIG}'`)}, ${text}, ${searchQuery(q)}, 'MaxFragments=2, MaxWords=14, MinWords=6, StartSel=<b>, StopSel=</b>')`;

/**
 * The list fields of a searchable table: `q` (`?q=words`, filtering on
 * the vector) and `rank` (`?sort=-rank`: the best match first, by the
 * request's `q`; without one every rank is 0 and the id orders).
 */
export const searchFields = (
  vector: AnyPgColumn,
): Record<'q' | 'rank', FilterField> => ({
  q: {
    column: vector,
    type: 'string',
    ops: ['eq'],
    conditions: { eq: (value) => matches(vector, String(value)) },
  },
  rank: {
    column: (query) => rank(vector, typeof query.q === 'string' ? query.q : ''),
    type: 'number',
    ops: [],
    sortable: true,
  },
});
