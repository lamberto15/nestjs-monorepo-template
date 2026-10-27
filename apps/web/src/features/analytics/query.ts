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

/**
 * SQL for one page of a dataset query. Column names must be in `allowed`; the page
 * never submits SQL, so every identifier and literal here is generated or escaped.
 */
export function buildDatasetSql(
  tableName: string,
  allowed: Set<string>,
  query: DatasetQuery,
): { rows: string; total: string } {
  const { limit, offset } = boundedPage(query);
  const where = buildWhereClause(query.filters, allowed);
  const table = quoteIdentifier(tableName);
  let select = '*';
  let group = '';
  if (query.groupBy || query.aggregate) {
    if (!query.groupBy || !allowed.has(query.groupBy))
      throw new Error('Choose a valid grouping column.');
    const aggregation = query.aggregate;
    if (!aggregation) throw new Error('Choose an aggregate operation.');
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(aggregation.fn))
      throw new Error('Unsupported aggregate operation.');
    const column =
      aggregation.fn === 'count' && !aggregation.column
        ? '*'
        : aggregation.column;
    if (column !== '*' && (!column || !allowed.has(column)))
      throw new Error('Choose a valid aggregate column.');
    const call = `${aggregation.fn.toUpperCase()}(${column === '*' ? '*' : quoteIdentifier(column)})`;
    // SUM of an integer column is a HUGEINT and SUM of a DECIMAL a DECIMAL: both
    // reach the page as Arrow objects it cannot chart. SUM and AVG are therefore
    // cast to DOUBLE (exact up to 2^53, the precision a chart shows anyway).
    // COUNT, MIN and MAX keep their type; a BIGINT among them becomes a number in
    // arrowTableRows (see there).
    const value =
      aggregation.fn === 'sum' || aggregation.fn === 'avg'
        ? `CAST(${call} AS DOUBLE)`
        : call;
    select = `${quoteIdentifier(query.groupBy)}, ${value} AS value`;
    group = ` GROUP BY ${quoteIdentifier(query.groupBy)}`;
  }
  const sortColumn = query.sort?.column;
  const sortable = query.groupBy ? new Set([query.groupBy, 'value']) : allowed;
  if (sortColumn && !sortable.has(sortColumn))
    throw new Error('A sort refers to an unknown column.');
  const order =
    sortColumn && sortable.has(sortColumn)
      ? ` ORDER BY ${quoteIdentifier(sortColumn)} ${query.sort?.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
      : '';
  return {
    total: query.groupBy
      ? `SELECT count(*) AS count FROM (SELECT ${quoteIdentifier(query.groupBy)} FROM ${table}${where}${group}) grouped`
      : `SELECT count(*) AS count FROM ${table}${where}`,
    rows: `SELECT ${select} FROM ${table}${where}${group}${order} LIMIT ${limit} OFFSET ${offset}`,
  };
}
