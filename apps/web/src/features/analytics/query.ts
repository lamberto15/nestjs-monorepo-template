import type { DatasetFilter, DatasetQuery } from './engine';

export const MAX_QUERY_ROWS = 500;
export const MAX_QUERY_OFFSET = 10_000_000;

export const quoteIdentifier = (value: string) =>
  `"${value.replaceAll('"', '""')}"`;
export const quoteLiteral = (value: string) =>
  `'${value.replaceAll("'", "''")}'`;

export function buildWhereClause(
  filters: DatasetFilter[] = [],
  allowed: Set<string>,
): string {
  if (filters.length > 20) throw new Error('Use at most 20 filters at a time.');
  const clauses = filters.map(({ column, operator, value }) => {
    if (!allowed.has(column))
      throw new Error('A filter refers to an unknown column.');
    const identifier = quoteIdentifier(column);
    if (operator === 'isNull') return `${identifier} IS NULL`;
    if (operator === 'isNotNull') return `${identifier} IS NOT NULL`;
    if (operator === 'contains') {
      const pattern = `%${String(value ?? '')
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_')}%`;
      return `CAST(${identifier} AS VARCHAR) ILIKE ${quoteLiteral(pattern)} ESCAPE '\\'`;
    }
    const op: Record<string, string> = {
      eq: '=',
      neq: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    };
    if (!op[operator]) throw new Error('Unsupported filter operator.');
    if (value === null)
      return `${identifier} ${operator === 'neq' ? 'IS NOT NULL' : 'IS NULL'}`;
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Filter values must be finite.');
    const safeValue =
      typeof value === 'number'
        ? String(value)
        : typeof value === 'boolean'
          ? String(value)
          : quoteLiteral(String(value ?? ''));
    return `${identifier} ${op[operator]} ${safeValue}`;
  });
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

export function boundedPage(query: DatasetQuery) {
  return {
    limit: Math.min(
      Math.max(Math.trunc(query.limit ?? 100), 1),
      MAX_QUERY_ROWS,
    ),
    offset: Math.min(
      Math.max(Math.trunc(query.offset ?? 0), 0),
      MAX_QUERY_OFFSET,
    ),
  };
}

export const MAX_HISTOGRAM_BINS = 100;
export const DEFAULT_HISTOGRAM_BINS = 20;
/** The result column of a grouping column that is itself named `value`. */
const GROUP_VALUE_ALIAS = 'value (group)';
const TIME_UNITS = ['day', 'week', 'month'];

/** The aggregate call over a validated column; `value` aliases it in the result. */
function aggregateValue(
  aggregation: NonNullable<DatasetQuery['aggregate']>,
  allowed: Set<string>,
): string {
  if (!['count', 'sum', 'avg', 'min', 'max'].includes(aggregation.fn))
    throw new Error('Unsupported aggregate operation.');
  const column =
    aggregation.fn === 'count' && !aggregation.column
      ? '*'
      : aggregation.column;
  if (column !== '*' && (!column || !allowed.has(column)))
    throw new Error('Choose a valid aggregate column.');
  const call = `${aggregation.fn.toUpperCase()}(${column === '*' ? '*' : quoteIdentifier(column)})`;
  // SUM of an integer column is a HUGEINT; SUM, MIN and MAX of a DECIMAL a
  // DECIMAL: Arrow hands those back as objects the page cannot chart or print
  // (a DecimalBigNum shows as a quoted string without its scale). Every
  // aggregate but COUNT is therefore cast to DOUBLE (exact up to 2^53, the
  // precision a chart shows anyway). COUNT is a BIGINT that becomes a number in
  // arrowTableRows (see there).
  return aggregation.fn === 'count' ? call : `CAST(${call} AS DOUBLE)`;
}

/** The filters plus one more condition, as a WHERE clause. */
const withCondition = (where: string, condition: string) =>
  where ? `${where} AND ${condition}` : ` WHERE ${condition}`;

/**
 * SQL for one page of a dataset query. Column names must be in `allowed`; the page
 * never submits SQL, so every identifier and literal here is generated or escaped.
 * A query is a plain page, a group-by with an aggregate, a histogram or a time
 * series; the last three are bounded (bins at most MAX_HISTOGRAM_BINS, a page at
 * most MAX_QUERY_ROWS).
 */
export function buildDatasetSql(
  tableName: string,
  allowed: Set<string>,
  query: DatasetQuery,
): { rows: string; total: string } {
  const { limit, offset } = boundedPage(query);
  const where = buildWhereClause(query.filters, allowed);
  const table = quoteIdentifier(tableName);
  // An aggregate alone belongs to a group-by; a time series takes one for its value.
  const shapes = [
    query.groupBy || (!query.timeSeries && query.aggregate),
    query.histogram,
    query.timeSeries,
  ].filter(Boolean);
  if (shapes.length > 1)
    throw new Error('Choose one of grouping, histogram or time series.');

  const histogram = query.histogram;
  if (histogram) {
    if (!allowed.has(histogram.column))
      throw new Error('Choose a valid histogram column.');
    const requested = Number.isFinite(histogram.bins)
      ? Math.trunc(histogram.bins as number)
      : DEFAULT_HISTOGRAM_BINS;
    const bins = Math.min(Math.max(requested, 1), MAX_HISTOGRAM_BINS);
    const column = quoteIdentifier(histogram.column);
    // Equal-width bins between the filtered minimum and maximum of the finite
    // values (NaN and the infinities have no bin); the maximum goes into the last
    // bin, and a single distinct value into bin 0. The position is computed on
    // halves and the bin start as a blend of lo and hi, so a range as wide as
    // DOUBLE itself cannot overflow.
    const rows = `WITH r AS (SELECT CAST(${column} AS DOUBLE) AS v FROM ${table}${withCondition(where, `isfinite(CAST(${column} AS DOUBLE))`)}), s AS (SELECT min(v) AS lo, max(v) AS hi FROM r), k AS (SELECT CASE WHEN s.hi = s.lo THEN 0 ELSE least(greatest(CAST(floor(((r.v / 2 - s.lo / 2) / (s.hi / 2 - s.lo / 2)) * ${bins}) AS INTEGER), 0), ${bins - 1}) END AS bucket, s.lo AS lo, s.hi AS hi FROM r, s) SELECT lo * (1.0 - CAST(bucket AS DOUBLE) / ${bins}) + hi * (CAST(bucket AS DOUBLE) / ${bins}) AS bin, count(*) AS value FROM k GROUP BY bucket, lo, hi ORDER BY bucket`;
    return {
      total: `SELECT count(*) AS count FROM (${rows}) binned`,
      rows: `${rows} LIMIT ${limit} OFFSET ${offset}`,
    };
  }

  const series = query.timeSeries;
  if (series) {
    if (!allowed.has(series.column))
      throw new Error('Choose a valid time series column.');
    if (!TIME_UNITS.includes(series.unit))
      throw new Error('Unsupported time unit.');
    const column = quoteIdentifier(series.column);
    const value = aggregateValue(query.aggregate ?? { fn: 'count' }, allowed);
    const rows = `SELECT CAST(CAST(date_trunc(${quoteLiteral(series.unit)}, CAST(${column} AS TIMESTAMP)) AS DATE) AS VARCHAR) AS bucket, ${value} AS value FROM ${table}${withCondition(where, `${column} IS NOT NULL`)} GROUP BY 1 ORDER BY 1`;
    return {
      total: `SELECT count(*) AS count FROM (${rows}) bucketed`,
      rows: `${rows} LIMIT ${limit} OFFSET ${offset}`,
    };
  }

  let select = '*';
  let group = '';
  if (query.groupBy || query.aggregate) {
    if (!query.groupBy || !allowed.has(query.groupBy))
      throw new Error('Choose a valid grouping column.');
    const aggregation = query.aggregate;
    if (!aggregation) throw new Error('Choose an aggregate operation.');
    const value = aggregateValue(aggregation, allowed);
    // The result's `value` is the aggregate; a grouping column of that very name
    // is renamed so the two do not merge into one key.
    const key =
      query.groupBy === 'value'
        ? `${quoteIdentifier('value')} AS ${quoteIdentifier(GROUP_VALUE_ALIAS)}`
        : quoteIdentifier(query.groupBy);
    select = `${key}, ${value} AS value`;
    group = ` GROUP BY ${quoteIdentifier(query.groupBy)}`;
  }
  const sortColumn = query.sort?.column;
  const sortable = query.groupBy ? new Set([query.groupBy, 'value']) : allowed;
  if (sortColumn && !sortable.has(sortColumn))
    throw new Error('A sort refers to an unknown column.');
  // Positional, so a table column named like the `value` alias cannot be sorted
  // by mistake: `value` is the aggregate (2), the grouping column the key (1).
  const orderTarget = query.groupBy
    ? sortColumn === 'value'
      ? '2'
      : '1'
    : sortColumn && quoteIdentifier(sortColumn);
  const order =
    sortColumn && sortable.has(sortColumn)
      ? ` ORDER BY ${orderTarget} ${query.sort?.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
      : '';
  return {
    total: query.groupBy
      ? `SELECT count(*) AS count FROM (SELECT ${quoteIdentifier(query.groupBy)} FROM ${table}${where}${group}) grouped`
      : `SELECT count(*) AS count FROM ${table}${where}`,
    rows: `SELECT ${select} FROM ${table}${where}${group}${order} LIMIT ${limit} OFFSET ${offset}`,
  };
}

export const MAX_DUPLICATE_SAMPLES = 5;
export const MAX_PARSE_CHECKS = 100;

/**
 * How the import check reads a file, so it sees what the server's parsers see
 * (apps/api platform/data-transfer/formats.ts):
 * - CSV: every value as text (`all_varchar`). The server's CSV parser also
 *   yields text, and DuckDB's own typing would hide what matters: it reads
 *   `31/01/2024` as a DATE, which the server refuses.
 * - JSON: only an array of objects (`format = 'array'`), the one shape the
 *   server accepts; `read_json` by default also reads JSON Lines.
 */
export function buildImportReaderSql(
  extension: 'csv' | 'json',
  source: string,
): string {
  return extension === 'csv'
    ? `read_csv(${source}, sample_size = -1, all_varchar = true)`
    : `read_json(${source}, format = 'array', sample_size = -1)`;
}

/**
 * The header row exactly as the file spells it: DuckDB renames repeated
 * headers (`a,a` reads as `a,a_1`; `Name,name` as `Name,name_1`).
 */
export const buildRawHeaderSql = (source: string): string =>
  `SELECT * FROM read_csv(${source}, header = false, all_varchar = true) LIMIT 1`;

/**
 * A value as the server reads it: text, trimmed, and a blank one as NULL
 * (csv-parse `trim: true`; `String(value ?? '').trim()` for a match key).
 * `json`: the column is JSON-typed (a mix of `"12"` and `5`): its text is the
 * string itself, not its quoted JSON form.
 */
export function importValueSql(identifier: string, json = false): string {
  const text = json ? `${identifier}->>'$'` : `CAST(${identifier} AS VARCHAR)`;
  return `nullif(trim(${text}), '')`;
}

const ISO_DATE = `[0-9]{4}-[0-9]{2}-[0-9]{2}`;
const ISO_CLOCK = `[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?`;

/**
 * What a text value must be for the server to take it as the type; SQL for
 * "this non-blank value is NOT acceptable".
 * - number: `Number(text)` is finite (coerceImported, custom-field.values.ts).
 * - boolean: true/false, 1/0, yes/no, whatever the case (same function).
 * - date: `YYYY-MM-DD`, real calendar day, optionally followed by a `T` suffix
 *   that is cut off (`z.iso.date()`; coerceImported keeps the first 10 chars).
 * - datetime: ISO 8601 date, `T` or space, a clock and an optional zone: the
 *   wall-clock form of a zoned column (`instantOf`) or an instant. A date
 *   alone, or `31/01/2024 10:00`, is refused (`z.iso.datetime()`).
 */
const NOT_ACCEPTED: Record<
  'number' | 'boolean' | 'date' | 'datetime',
  (value: string) => string
> = {
  number: (v) => `NOT coalesce(isfinite(try_cast(${v} AS DOUBLE)), false)`,
  boolean: (v) => `lower(${v}) NOT IN ('true', 'false', '1', '0', 'yes', 'no')`,
  date: (v) =>
    `NOT (regexp_full_match(${v}, '${ISO_DATE}(T.*)?') AND try_cast(left(${v}, 10) AS DATE) IS NOT NULL)`,
  datetime: (v) =>
    `NOT (regexp_full_match(${v}, '${ISO_DATE}[ T]${ISO_CLOCK}(Z|[+-][0-9]{2}(:?[0-9]{2})?)?') AND try_cast(${v} AS TIMESTAMPTZ) IS NOT NULL)`,
};
export type ParseTarget = keyof typeof NOT_ACCEPTED;

/**
 * Duplicates of a match key: `extra` is the number of rows whose key was
 * already seen (blank keys are not counted: the server refuses those on
 * their own), `samples` the most repeated values (at most
 * MAX_DUPLICATE_SAMPLES, each with its row count). The key is compared
 * trimmed, as the server does.
 */
export function buildDuplicateKeySql(
  tableName: string,
  allowed: Set<string>,
  key: string,
): { count: string; samples: string } {
  if (!allowed.has(key)) throw new Error('Choose a valid match key column.');
  const table = quoteIdentifier(tableName);
  const value = importValueSql(quoteIdentifier(key));
  return {
    count: `SELECT count(${value}) - count(DISTINCT ${value}) AS extra FROM ${table}`,
    samples: `SELECT ${value} AS key, count(*) AS rows FROM ${table} WHERE ${value} IS NOT NULL GROUP BY ${value} HAVING count(*) > 1 ORDER BY 2 DESC, 1 LIMIT ${MAX_DUPLICATE_SAMPLES}`,
  };
}

/**
 * One statement counting, per checked column, the non-blank values the server
 * would not take as the target type (see NOT_ACCEPTED). Result aliases are
 * positional (`n0`, `n1`, ...): a column may be named like an alias.
 */
export function buildParseFailureSql(
  tableName: string,
  allowed: Set<string>,
  checks: { column: string; as: ParseTarget; json?: boolean }[],
): string {
  if (checks.length === 0 || checks.length > MAX_PARSE_CHECKS)
    throw new Error(`Check between 1 and ${MAX_PARSE_CHECKS} columns.`);
  const counts = checks.map(({ column, as, json }, index) => {
    if (!allowed.has(column))
      throw new Error('A check refers to an unknown column.');
    const notAccepted = NOT_ACCEPTED[as];
    if (!notAccepted) throw new Error('Unsupported check type.');
    const value = importValueSql(quoteIdentifier(column), json);
    return `count(*) FILTER (WHERE ${value} IS NOT NULL AND ${notAccepted(value)}) AS n${index}`;
  });
  return `SELECT ${counts.join(', ')} FROM ${quoteIdentifier(tableName)}`;
}
