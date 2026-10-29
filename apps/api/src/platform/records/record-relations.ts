import { UnprocessableEntityException } from '@nestjs/common';
import { getTableName } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ProblemDetailsFilter } from '../../core/http/problem-details.filter.js';
import {
  type AnyField,
  columnName,
  type OnDelete,
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
 * - deleting a record that others refer to follows the relation's
 *   `onDelete` (`.onDelete()` on the field): `restrict`, the default, refuses
 *   it while live records refer to it (409 `record_referenced`; for a
 *   required field the recycle bin's too, as the key would refuse the
 *   purge); `keep` (optional fields) lets it go to the recycle bin, the
 *   references kept, so a restore brings the relation back. An optional
 *   reference empties when its record is deleted for good (the key's
 *   `set null`). Restoring a record whose `restrict` reference points at one
 *   in the recycle bin is refused (409 `reference_deleted`): restore that
 *   one first;
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
  /** A required field (its key: `restrict`); optional ones empty (`set null`). */
  required: boolean;
  /** Deleting the referred record: refused while referred to, or kept in the bin. */
  onDelete: OnDelete;
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
    const onDelete = f.options.onDelete ?? 'restrict';
    if (onDelete === 'keep' && !f.options.optional) {
      // Its key would refuse purging the record the bin kept it for.
      throw new Error(
        `${declaration.subject}.${field}: onDelete('keep') needs an optional reference (one that empties when its record is purged).`,
      );
    }
    RELATIONS.push({
      from: declaration,
      field,
      table,
      column: table[field]!,
      required: !f.options.optional,
      onDelete,
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

/**
 * A write whose reference names no row the key finds (another tenant's, or
 * none at all): RecordLifecycle checks references after the row is written,
 * so the key refuses it first. The same 422 `reference_not_found` as the
 * check's, named by the key's constraint (`<table>_<column>_fk`,
 * fieldExtras), instead of a 500. Deletes still referred to are the
 * services' own (isStillReferenced).
 */
ProblemDetailsFilter.map(Error, (error) => {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const { code, message, constraint } = e as {
      code?: unknown;
      message?: unknown;
      constraint?: unknown;
    };
    if (
      code === '23503' &&
      typeof message === 'string' &&
      message.startsWith('insert or update')
    ) {
      const relation = RELATIONS.find(
        (r) =>
          `${getTableName(r.table)}_${columnName(r.field)}_fk` === constraint,
      );
      if (!relation) return undefined;
      return new UnprocessableEntityException(
        {
          code: 'reference_not_found',
          message: `${relation.field}: no ${relation.target() ?? 'record'} with this id that you may read.`,
          field: relation.field,
        },
        { cause: error },
      );
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
});
