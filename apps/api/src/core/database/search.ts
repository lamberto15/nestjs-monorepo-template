import { BadRequestException } from '@nestjs/common';
import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type PgTable,
  customType,
} from 'drizzle-orm/pg-core';
import type { FilterField, ListQuery } from '../http/list-query.js';
import { countPage } from '../http/pagination.js';
import type { SortBy } from '../http/list-sort.js';
import type { Database, Transaction } from './drizzle.js';

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
 * // the list: ?q=… filters, ?sort=-rank orders the best first; the fields the vector is made of
 * export const NOTE_LIST = listQuery({ ...searchFields(notes.search, ['title', 'body']), … });
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
 * A vector of `columns` made now, for a search that must not match the
 * stored vector's other fields (a field the caller may not read): the
 * stored one's text, without its index.
 */
export const vectorOf = (columns: readonly (AnyColumn | SQL)[]) =>
  sql`to_tsvector(${sql.raw(`'${CONFIG}'`)}, concat_ws(' ', ${sql.join(
    columns.map((column) => sql`${column}::text`),
    sql`, `,
  )}))`;

/**
 * The list fields of a searchable table: `q` (`?q=words`, filtering on
 * the vector) and `rank` (`?sort=-rank`: the best match first, by the
 * request's `q`; without one every rank is 0 and the id orders).
 * `fields`: the record fields the vector is made of, so field-level
 * permissions refuse `q` to whoever may read one of them on no record
 * (a match would tell what the hidden text holds).
 */
export const searchFields = (
  vector: AnyPgColumn,
  fields: readonly string[],
): Record<'q' | 'rank', FilterField> => ({
  q: {
    column: vector,
    type: 'string',
    ops: ['eq'],
    conditions: { eq: (value) => matches(vector, String(value)) },
    reads: fields,
  },
  rank: {
    // Without a `q` every rank is 0: no `ts_rank` per row, the id orders.
    column: (query) =>
      typeof query.q === 'string'
        ? rank(vector, query.q)
        : sql<number>`0::real`,
    type: 'number',
    ops: [],
    sortable: true,
    reads: fields,
  },
});

/**
 * The most matches a rank sort or the global search ranks. Ranking reads
 * every row it ranks (a GIN index holds no rank), so its cost grows with
 * the matches, not with `limit`; past this the caller narrows `q`.
 */
export const RANK_CAP = 1_000;

/**
 * A 400 `search_too_broad` when `?sort=` ranks (`rank`) a `q` that matches
 * more than `cap` records. `where` is the page's own filter without the
 * cursor, so the decision is the same on every page. No query unless the
 * sort has `rank` and there is a `q`.
 */
export async function refuseBroadRank(
  db: Database | Transaction,
  table: PgTable,
  where: SQL | undefined,
  query: ListQuery,
  cap = RANK_CAP,
): Promise<void> {
  const sort = query.sort as SortBy[] | undefined;
  if (
    !sort?.some((item) => item.name === 'rank') ||
    typeof query.q !== 'string' ||
    query.q === ''
  ) {
    return;
  }
  const total = await countPage(
    db,
    table,
    where,
    { ...query, count: true },
    cap,
  );
  if (total?.totalCapped) {
    throw new BadRequestException({
      code: 'search_too_broad',
      message: `More than ${cap} records match: narrow q to sort by rank.`,
    });
  }
}
