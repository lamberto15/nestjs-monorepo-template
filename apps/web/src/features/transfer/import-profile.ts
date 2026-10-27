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
export type FileColumn = { name: string; type: string; nullCount: number };

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
 * A VARCHAR column (DuckDB found no better type) is accepted for number,
 * boolean, date and datetime unless some values do not parse as the catalog's
 * type (`try_cast`, counted by `checkDataset`): then the column is reported
 * with how many values do not. The cast is DuckDB's, not the server's, so the
 * count is a likelihood, not a verdict.
 */
export type TypeKind = 'number' | 'boolean' | 'date' | 'datetime';
const CHECKED: readonly string[] = ['number', 'boolean', 'date', 'datetime'];

const isVarchar = (type: string) => /^VARCHAR$/i.test(type.trim());
const isBoolean = (type: string) => /^BOOLEAN$/i.test(type.trim());
const isInteger = (type: string) =>
  isNumericColumn(type) && /INT/i.test(type) && !/DECIMAL/i.test(type);

function contradicts(expected: TypeKind, detected: string): boolean {
  switch (expected) {
    case 'number':
      return !isNumericColumn(detected) && !isVarchar(detected);
    case 'boolean':
      return (
        !isBoolean(detected) && !isInteger(detected) && !isVarchar(detected)
      );
    case 'date':
    case 'datetime':
      return !isTemporalColumn(detected) && !isVarchar(detected);
  }
}

const isCheckedKind = (type: string): type is TypeKind =>
  CHECKED.includes(type);

/** Each catalog column that the file has, with the file's name for it. */
export function matchColumns(
  catalog: CatalogColumn[],
  file: FileColumn[],
): {
  matches: { catalog: CatalogColumn; file: FileColumn }[];
  unknown: string[];
} {
  const byName = new Map(catalog.map((column) => [column.name, column]));
  const matches: { catalog: CatalogColumn; file: FileColumn }[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const column of file) {
    let target = byName.get(column.name);
    if (!target) {
      // A zoned datetime header names its column without the zone.
      const zoned = ZONED_HEADER.exec(column.name);
      const base = zoned && byName.get(zoned[1]!);
      if (base?.type === 'datetime') target = base;
    }
    if (target && !seen.has(target.name)) {
      seen.add(target.name);
      matches.push({ catalog: target, file: column });
    } else {
      unknown.push(column.name);
    }
  }
  return { matches, unknown };
}

/** What `checkDataset` should count for this file and match key. */
export function planChecks(input: {
  catalog: CatalogColumn[];
  columns: FileColumn[];
  rowCount: number;
  matchOn?: string;
}): DatasetCheckRequest {
  const { matches } = matchColumns(input.catalog, input.columns);
  const request: DatasetCheckRequest = {};
  const key = matches.find(({ catalog }) => catalog.name === input.matchOn);
  if (key) request.duplicateKey = key.file.name;
  const parse = matches.flatMap(({ catalog, file }) =>
    isCheckedKind(catalog.type) &&
    isVarchar(file.type) &&
    file.nullCount < input.rowCount
      ? [{ column: file.name, as: catalog.type }]
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
  checks?: DatasetChecks;
}): ImportFindings {
  const { matches, unknown } = matchColumns(input.catalog, input.columns);
  const present = new Set(matches.map(({ catalog }) => catalog.name));
  const findings: ImportFindings = {
    missingRequired: input.catalog
      .filter(({ required, name }) => required && !present.has(name))
      .map(({ name }) => name),
    unknown,
    types: [],
    nullHeavy: [],
  };
  if (input.matchOn && !present.has(input.matchOn))
    findings.matchKeyMissing = input.matchOn;
  for (const { catalog, file } of matches) {
    if (isCheckedKind(catalog.type)) {
      const bad = input.checks?.unparseable[file.name];
      const mismatch = isVarchar(file.type)
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
    findings.types.length +
    findings.nullHeavy.length >
    0 ||
  findings.matchKeyMissing !== undefined ||
  findings.duplicates !== undefined;
