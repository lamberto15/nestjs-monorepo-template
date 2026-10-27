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
