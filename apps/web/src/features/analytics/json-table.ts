import { Bool, Float64, Utf8, Table, vectorFromArray } from 'apache-arrow';

/**
 * Build Arrow columns from the union of JSON row keys. Heterogeneous and nested
 * fields become JSON text so Arrow's primitive type inference cannot lose values.
 */
export function jsonRowsToArrow(rows: Record<string, unknown>[]) {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (rows.length === 0 || names.length === 0) {
    throw new Error('The JSON file has no tabular fields.');
  }

  const columns = Object.fromEntries(
    names.map((name) => {
      const values = rows.map((row) =>
        Object.hasOwn(row, name) ? (row[name] ?? null) : null,
      );
      const present = values.filter((value) => value !== null);
      if (
        present.length === 0 ||
        present.every((value) => typeof value === 'string')
      ) {
        return [name, vectorFromArray(values as (string | null)[], new Utf8())];
      }
      if (
        present.every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        )
      ) {
        return [
          name,
          vectorFromArray(values as (number | null)[], new Float64()),
        ];
      }
      if (present.every((value) => typeof value === 'boolean')) {
        return [
          name,
          vectorFromArray(values as (boolean | null)[], new Bool()),
        ];
      }
      const jsonValues = values.map((value) =>
        value === null ? null : JSON.stringify(value),
      );
      return [name, vectorFromArray(jsonValues, new Utf8())];
    }),
  );
  // Arrow 17's tableFromArrays copies through {}, where a __proto__ column
  // changes the object's prototype. These values are already typed vectors.
  return new Table(columns);
}
