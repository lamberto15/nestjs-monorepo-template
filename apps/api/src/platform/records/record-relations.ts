import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  type AnyField,
  type Referenced,
  referencedSubject,
} from '../fields/field.js';
import type { RecordDeclaration } from './record.js';

/**
 * A relationship between records, declared once: a `ref` field of one
 * record's declaration (`parentId: field.ref(…)` in `<item>.record.ts`)
 * points at another's (one to many: many referring records, one
 * referred to). The key, its index and the list filter come from the field
 * (platform/fields); from the relation the platform derives the rest:
 *
 * - a write may only point at a live record the writer may read
 *   (RecordLifecycle, 422 `reference_not_found`);
 * - a record a required relation still refers to can't be deleted
 *   (409 `record_referenced`); an optional one empties when its record is
 *   deleted for good (the key's `set null`), and stays while that record is
 *   in the recycle bin, so a restore brings the relation back;
 * - the referred record's related panels (`related` of
 *   GET /v1/lists/{subject}: each a page of the referring list, filtered by
 *   the field, with the caller's read permission).
 *
 * No Nest here: `recordTable()` registers each record's relations when its
 * table is made, and anything may ask for them (merging duplicates repoints
 * them: `relationsTo()` names each table and column that refers).
 */
export interface RecordRelation {
  /** The referring records' declaration: `InvoiceLine`. */
  from: RecordDeclaration;
  /** Their field holding the referred record's id: `invoiceId`. */
  field: string;
  /** Their table, and the field's column. */
  table: PgTable & Record<string, AnyPgColumn>;
  column: AnyPgColumn;
  /** A required field (`restrict`); optional ones empty (`set null`). */
  required: boolean;
  /** The subject referred to (`Invoice`), read when asked: its table may load later. */
  target: () => string | undefined;
  /** The table referred to. */
  targetTable: () => Referenced & PgTable;
}

const RELATIONS: RecordRelation[] = [];

/** Registers the relations of a record's `ref` fields (recordTable). */
export function relate(
  declaration: RecordDeclaration,
  table: PgTable & Record<string, AnyPgColumn>,
) {
  for (const [field, f] of Object.entries(declaration.fields) as [
    string,
    AnyField,
  ][]) {
    if (f.kind !== 'ref') continue;
    RELATIONS.push({
      from: declaration,
      field,
      table,
      column: table[field]!,
      required: !f.options.optional,
      target: () => referencedSubject(f),
      targetTable: () => f.options.ref!() as Referenced & PgTable,
    });
  }
}

/** The relations that refer to `subject`'s records. */
export const relationsTo = (subject: string) =>
  RELATIONS.filter((relation) => relation.target() === subject);

/** The relations of `declaration`'s own `ref` fields. */
export const relationsFrom = (declaration: RecordDeclaration) =>
  RELATIONS.filter((relation) => relation.from === declaration);

/** The field a client names a referring record by: its first string field, or null. */
export const relationTitle = (declaration: RecordDeclaration) =>
  Object.entries(declaration.fields).find(
    ([, f]) => (f as AnyField).kind === 'string',
  )?.[0] ?? null;
