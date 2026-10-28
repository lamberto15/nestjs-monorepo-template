import { isTimeZone } from '../../core/config/env.helpers.js';
import type { ImportColumn } from './data-transfer.types.js';

/**
 * How an import's file columns map to the importer's: each file header to a
 * column of the template, or null to ignore it. A header the mapping doesn't
 * name keeps its own name (the template's columns import as before). A
 * date-time target may carry the zone of the file's times, as a template's
 * header does: `dueAt (Asia/Dubai)`.
 */
export type ImportMapping = Record<string, string | null>;

const ZONED_HEADER = /^(.+) \(([^()]+)\)$/;

/**
 * The column a header names, and the zone of its times when it is a
 * date-time column (`createdAt (Asia/Dubai)`).
 */
export function headerColumn(header: string): { key: string; zone?: string } {
  const zoned = ZONED_HEADER.exec(header);
  return zoned && isTimeZone(zoned[2]!)
    ? { key: zoned[1]!, zone: zoned[2]! }
    : { key: header };
}

/**
 * The file's headers as the importer reads them: renamed by the mapping,
 * `null` where it ignores a column. Two columns that end up with the same
 * name are refused (their values would overwrite each other).
 */
export function renameHeaders(
  headers: readonly string[],
  mapping: ImportMapping | undefined,
): (string | null)[] {
  const renamed = headers.map((header) =>
    mapping && Object.hasOwn(mapping, header) ? mapping[header]! : header,
  );
  const seen = new Set<string>();
  for (const header of renamed) {
    if (header === null || header === undefined) continue;
    const { key } = headerColumn(header);
    if (seen.has(key)) {
      throw new MappingError(`More than one column of the file is "${key}".`);
    }
    seen.add(key);
  }
  return renamed.map((header) => header ?? null);
}

/** A mapping that can't be applied to the file (the import fails with this reason). */
export class MappingError extends Error {}

/**
 * The problems of a mapping against the columns a principal may fill:
 * a target that is not one (a column the schema no longer has, a field
 * their permissions hide), the same target twice, a zone on a column that
 * isn't a date-time. Empty: it is valid.
 */
export function mappingProblems(
  mapping: ImportMapping,
  columns: readonly ImportColumn[],
): string[] {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const problems: string[] = [];
  const used = new Map<string, string>();
  for (const [header, target] of Object.entries(mapping)) {
    if (target === null) continue;
    const { key, zone } = headerColumn(target);
    const column = byName.get(key);
    if (!column) {
      problems.push(`"${header}" maps to "${key}", which you cannot import.`);
      continue;
    }
    if (zone && column.type !== 'datetime') {
      problems.push(`"${key}" is not a date-time column: it takes no zone.`);
    }
    const first = used.get(key);
    if (first !== undefined) {
      problems.push(`"${first}" and "${header}" both map to "${key}".`);
    } else {
      used.set(key, header);
    }
  }
  return problems;
}

/** The targets of a mapping that are no longer columns the principal may fill. */
export function staleTargets(
  mapping: ImportMapping,
  columns: readonly ImportColumn[],
): string[] {
  const names = new Set(columns.map((column) => column.name));
  return Object.values(mapping)
    .filter((target): target is string => target !== null)
    .map((target) => headerColumn(target).key)
    .filter((key) => !names.has(key));
}
