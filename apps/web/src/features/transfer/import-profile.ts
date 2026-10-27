import type { DatasetCheckRequest, DatasetChecks } from '../analytics/engine';
import { isNumericColumn, isTemporalColumn } from '../analytics/column-types';

/**
 * The local check of an import file against the catalog (`GET /v1/data`):
 * pure functions over what DuckDB reported (names, types, null counts) and
 * what the two bounded queries counted (`checkDataset`). Informational only:
 * the server's `dryRun` is the authority on what an import accepts.
 */

/** The catalog's column (`imports[].columns[]`) fields this check reads. */
export type CatalogColumn = { name: string; type: string; required: boolean };
/** The loaded file's column (`AnalyticsDataset.columns[]`) fields this check reads. */
export type FileColumn = {
  name: string;
  type: string;
  nullCount: number;
  /**
   * The header as the file spells it, when it differs from `name` (DuckDB
   * renames a repeated header: `a,a` reads as `a,a_1`). Matching uses it;
   * queries use `name`.
   */
  header?: string;
};

const headerOf = (column: FileColumn) => column.header ?? column.name;

/**
 * A required column is "null-heavy" from this share of empty values on: at
 * least one row in five. Lower than that is usual for a column that a few rows
 * forgot; above it the file is probably missing data (a shifted column, an
 * export that dropped a field), which is what the person wants to hear about
 * before uploading. An entirely empty required column is always reported.
 */
export const NULL_HEAVY_SHARE = 0.2;

/** A zoned datetime header: `dueAt (Asia/Dubai)` (templates, docs/data-transfer.md). */
const ZONED_HEADER = /^(.+) \(([^()]+)\)$/;

/**
 * Whether `zone` is an IANA time zone, as the server decides it before it
 * reads a header as zoned (`isTimeZone`, apps/api core/config/env.helpers.ts).
 */
function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * How DuckDB's detected type (SUMMARIZE) is compared with the catalog's type.
 * Conservative: only a clear contradiction is reported.
 *
 * | catalog type          | detected, accepted                      | detected, reported                         |
 * | --------------------- | --------------------------------------- | ------------------------------------------ |
 * | text, list, others    | anything                                | never                                      |
 * | number                | integer, float, decimal                 | boolean, date/time, nested (STRUCT, LIST…) |
 * | boolean               | BOOLEAN, integers (0 and 1)             | float, date/time, nested                   |
 * | date, datetime        | DATE, TIMESTAMP*                        | number, boolean, nested                    |
 *
 * A CSV is read as text (VARCHAR) and a JSON column of mixed strings and
 * numbers is typed JSON: both are judged by their values, never by the type.
 * `checkDataset` counts the values the server would not take as the catalog's
 * type (`buildParseFailureSql`, which spells out the server's rule for each
 * type: `31/01/2024` is not a date, `maybe` is not a boolean) and the column
 * is reported with how many.
 */
export type TypeKind = 'number' | 'boolean' | 'date' | 'datetime';
const CHECKED: readonly string[] = ['number', 'boolean', 'date', 'datetime'];

const isVarchar = (type: string) => /^VARCHAR$/i.test(type.trim());
/**
 * DuckDB types a JSON column of mixed values (`"12"` and `5`) as JSON. The
 * server converts a string to the field's type (coerceImported), so such a
 * column is judged by its values, as a VARCHAR is, never by its type.
 */
const isJson = (type: string) => /^JSON$/i.test(type.trim());
const isText = (type: string) => isVarchar(type) || isJson(type);
const isBoolean = (type: string) => /^BOOLEAN$/i.test(type.trim());
const isInteger = (type: string) =>
  isNumericColumn(type) && /INT/i.test(type) && !/DECIMAL/i.test(type);

function contradicts(expected: TypeKind, detected: string): boolean {
  switch (expected) {
    case 'number':
      return !isNumericColumn(detected) && !isText(detected);
    case 'boolean':
      return !isBoolean(detected) && !isInteger(detected) && !isText(detected);
    case 'date':
    case 'datetime':
      return !isTemporalColumn(detected) && !isText(detected);
  }
}

const isCheckedKind = (type: string): type is TypeKind =>
  CHECKED.includes(type);

/**
 * Each catalog column that the file has, with the file's name for it.
 * `known` are headers the import reads although the catalog does not list them
 * as columns (the match keys: a notes import matches on `id` or `number`, read
 * from the raw record, data-transfer.processor.ts); they are never "unknown".
 * A header the file repeats is reported once in `repeated`: the server's CSV
 * parser keeps the last of them (csv-parse, `columns: true`).
 */
export function matchColumns(
  catalog: CatalogColumn[],
  file: FileColumn[],
  known: readonly string[] = [],
): {
  matches: { catalog: CatalogColumn; file: FileColumn }[];
  unknown: string[];
  repeated: string[];
} {
  const byName = new Map(catalog.map((column) => [column.name, column]));
  const matches: { catalog: CatalogColumn; file: FileColumn }[] = [];
  const unknown: string[] = [];
  const repeated: string[] = [];
  const seen = new Set<string>();
  const headers = new Set<string>();
  for (const column of file) {
    const header = headerOf(column);
    if (headers.has(header)) {
      if (!repeated.includes(header)) repeated.push(header);
      continue;
    }
    headers.add(header);
    let target = byName.get(header);
    if (!target) {
      // A zoned datetime header names its column without the zone, when the
      // parenthesis is a time zone (the server's `columnOf`).
      const zoned = ZONED_HEADER.exec(header);
      const base = zoned && isTimeZone(zoned[2]!) && byName.get(zoned[1]!);
      if (base && base.type === 'datetime') target = base;
    }
    if (target && !seen.has(target.name)) {
      seen.add(target.name);
      matches.push({ catalog: target, file: column });
    } else if (!known.includes(header)) {
      unknown.push(header);
    }
  }
  return { matches, unknown, repeated };
}

/** What `checkDataset` should count for this file and match key. */
export function planChecks(input: {
  catalog: CatalogColumn[];
  columns: FileColumn[];
  rowCount: number;
  matchOn?: string;
  matchKeys?: readonly string[];
}): DatasetCheckRequest {
  const { matches } = matchColumns(
    input.catalog,
    input.columns,
    input.matchKeys,
  );
  const request: DatasetCheckRequest = {};
  // The match key is read from the file's header, not from the catalog's
  // columns: a notes import matches on `id` or `number`, neither a column.
  const key =
    input.matchOn &&
    input.columns.find((column) => headerOf(column) === input.matchOn);
  if (key) request.duplicateKey = key.name;
  const parse = matches.flatMap(({ catalog, file }) =>
    isCheckedKind(catalog.type) &&
    isText(file.type) &&
    file.nullCount < input.rowCount
      ? [
          {
            column: file.name,
            as: catalog.type,
            ...(isJson(file.type) ? { json: true } : {}),
          },
        ]
      : [],
  );
  if (parse.length) request.parse = parse;
  return request;
}

export type ImportFindings = {
  /** Required catalog columns the file lacks. */
  missingRequired: string[];
  /** File columns the import does not take (the server ignores or refuses them). */
  unknown: string[];
  /** The chosen match key is not a column of the file. */
  matchKeyMissing?: string;
  /** Headers the file has twice (the server keeps the last column). */
  repeatedHeaders: string[];
  types: {
    column: string;
    expected: string;
    detected: string;
    /** Values that do not read as the expected type, when counted. */
    badValues?: number;
  }[];
  duplicates?: { column: string; extraRows: number; samples: string[] };
  nullHeavy: { column: string; share: number; nullCount: number }[];
};

export function compareImport(input: {
  catalog: CatalogColumn[];
  columns: FileColumn[];
  rowCount: number;
  matchOn?: string;
  matchKeys?: readonly string[];
  checks?: DatasetChecks;
}): ImportFindings {
  const { matches, unknown, repeated } = matchColumns(
    input.catalog,
    input.columns,
    input.matchKeys,
  );
  const present = new Set(matches.map(({ catalog }) => catalog.name));
  const findings: ImportFindings = {
    missingRequired: input.catalog
      .filter(({ required, name }) => required && !present.has(name))
      .map(({ name }) => name),
    unknown,
    repeatedHeaders: repeated,
    types: [],
    nullHeavy: [],
  };
  // The server reads the key from the file's header (the raw record), whether
  // or not it is a catalog column (data-transfer.processor.ts).
  if (
    input.matchOn &&
    !input.columns.some((column) => headerOf(column) === input.matchOn)
  )
    findings.matchKeyMissing = input.matchOn;
  for (const { catalog, file } of matches) {
    if (isCheckedKind(catalog.type)) {
      const bad = input.checks?.unparseable[file.name];
      const mismatch = isText(file.type)
        ? bad !== undefined && bad > 0
        : contradicts(catalog.type, file.type);
      if (mismatch)
        findings.types.push({
          column: file.name,
          expected: catalog.type,
          detected: file.type,
          ...(bad ? { badValues: bad } : {}),
        });
    }
    if (catalog.required && input.rowCount > 0) {
      const share = file.nullCount / input.rowCount;
      if (share >= NULL_HEAVY_SHARE)
        findings.nullHeavy.push({
          column: file.name,
          share,
          nullCount: file.nullCount,
        });
    }
  }
  const duplicates = input.checks?.duplicates;
  if (duplicates && duplicates.extraRows > 0)
    findings.duplicates = {
      column: duplicates.column,
      extraRows: duplicates.extraRows,
      samples: duplicates.samples.map((sample) => sample.value),
    };
  return findings;
}

/** Whether there is anything to tell. */
export const hasFindings = (findings: ImportFindings) =>
  findings.missingRequired.length +
    findings.unknown.length +
    findings.repeatedHeaders.length +
    findings.types.length +
    findings.nullHeavy.length >
    0 ||
  findings.matchKeyMissing !== undefined ||
  findings.duplicates !== undefined;
