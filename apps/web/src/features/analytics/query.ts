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
