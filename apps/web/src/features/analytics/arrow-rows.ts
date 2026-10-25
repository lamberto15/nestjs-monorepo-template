import { MapRow, StructRow, Vector, type Table } from 'apache-arrow';

function cloneableValue(value: unknown): unknown {
  // Arrow rows are proxies, so structuredClone cannot cross the worker boundary.
  // Their public iterators also preserve fields such as __proto__ that Arrow
  // 17's property lookup and toJSON implementation resolve incorrectly.
  if (value instanceof StructRow) {
    return Object.fromEntries(
      Array.from(value, ([key, child]) => [key, cloneableValue(child)]),
    );
  }
  if (value instanceof MapRow) {
    return new Map(
      Array.from(value, ([key, child]) => [
        cloneableValue(key),
        cloneableValue(child),
      ]),
    );
  }
  if (value instanceof Vector) return Array.from(value, cloneableValue);
  return value;
}

/** Materialize Arrow query results as values the browser worker can send. */
export function arrowTableRows(table: Table) {
  const columns = table.schema.fields.map((field) => field.name);
  const vectors = columns.map((_, index) => table.getChildAt(index)!);
  const rows = Array.from({ length: table.numRows }, (_, row) =>
    Object.fromEntries(
      columns.map((name, index) => [
        name,
        cloneableValue(vectors[index]!.get(row)),
      ]),
    ),
  );
  return { columns, rows };
}
