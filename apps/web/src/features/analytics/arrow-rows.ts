import { MapRow, StructRow, Vector, type Table } from 'apache-arrow';

function cloneableValue(value: unknown): unknown {
  // Arrow rows are proxies, so React state and structuredClone cannot hold them.
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

/**
 * One rule for 64-bit integers: DuckDB reads JSON and CSV integers as BIGINT and
 * counts as BIGINT, and Arrow hands those back as `bigint`, which Recharts and
 * the grouping keys of the page cannot use. A top-level cell inside JavaScript's
 * safe integer range therefore becomes a `number`; one beyond it stays a `bigint`
 * so no digit is lost (the page prints it with `String`). Values nested in
 * structs, lists and maps keep their native Arrow form.
 */
function topLevelValue(value: unknown): unknown {
  if (
    typeof value === 'bigint' &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return cloneableValue(value);
}

/** Materialize Arrow query results as plain values for the page. */
export function arrowTableRows(table: Table) {
  const columns = table.schema.fields.map((field) => field.name);
  const vectors = columns.map((_, index) => table.getChildAt(index)!);
  const rows = Array.from({ length: table.numRows }, (_, row) =>
    Object.fromEntries(
      columns.map((name, index) => [
        name,
        topLevelValue(vectors[index]!.get(row)),
      ]),
    ),
  );
  return { columns, rows };
}
