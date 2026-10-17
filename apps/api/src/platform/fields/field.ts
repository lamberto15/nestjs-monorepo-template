import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  decimalSchema,
  moneyResponseSchema,
  moneySchema,
} from '../money/money.schemas.js';

/**
 * A feature's fields, declared once (`<x>.record.ts`): each field knows its
 * column, its API schemas and its list filter, and the feature's table,
 * schemas, list, mapping, revisions, exports and PDF are derived from the
 * declaration (fields.ts, fields.list.ts). Adding a column is a line here and
 * `pnpm db:generate`; a change to how a type works reaches every feature.
 *
 * ```ts
 * fields: {
 *   title: field.string().searchable(),
 *   total: field.money(),
 *   dueOn: field.date().optional(),
 *   status: field.enum(['draft', 'sent', 'paid']).default('draft'),
 *   code: field.string().unique(),
 *   customerId: field.ref(() => customers).optional(),
 * }
 * ```
 *
 * No Nest in this file: drizzle-kit loads it through schema.ts.
 */

export type FieldKind =
  | 'string'
  | 'text'
  | 'int'
  | 'decimal'
  | 'money'
  | 'bool'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'json'
  | 'ref';

/** A referenced table: its tenant and id columns (`tenantReference`). */
export interface Referenced {
  tenantId: AnyPgColumn;
  id: AnyPgColumn;
}

/** The subjects of the tables `recordTable()` made, by table: what a `ref` field's list entry says its values are ids of. */
const SUBJECTS = new WeakMap<object, string>();

/** Remembers that `table` holds the records of `subject` (recordTable). */
export const tableHolds = (table: object, subject: string) =>
  void SUBJECTS.set(table, subject);

/**
 * The subject of a `ref` field's target: a record's table knows its own; a
 * hand-written table is named in `field.ref(() => notes, 'Note')`.
 */
export function referencedSubject(f: AnyField): string | undefined {
  const target = f.options.ref?.();
  return f.options.refSubject ?? (target && SUBJECTS.get(target));
}

/**
 * One field. `C` the column builder (before NOT NULL), `I` the input schema
 * and `O` the output one (both for a value present), `Opt` optional (null
 * allowed), `Def` has a default (the insert may leave it out).
 */
export class Field<
  K extends FieldKind = FieldKind,
  C = unknown,
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
  Opt extends boolean = boolean,
  Def extends boolean = boolean,
> {
  constructor(
    readonly kind: K,
    /** The column, named from the field (`dueOn` → `due_on`); null for money (two columns). */
    readonly makeColumn: ((name: string) => C) | null,
    readonly input: I,
    readonly output: O,
    readonly options: {
      optional: Opt;
      hasDefault: Def;
      defaultValue?: unknown;
      unique?: boolean;
      searchable?: boolean;
      values?: readonly string[];
      ref?: () => Referenced;
      /** The subject the referenced table holds, when it isn't a record's table. */
      refSubject?: string;
    },
  ) {}

  /** May be left empty: null in the column, `null` or absent in the body. */
  optional(): Field<K, C, I, O, true, Def> {
    return new Field(this.kind, this.makeColumn, this.input, this.output, {
      ...this.options,
      optional: true,
    });
  }

  /** The value a row gets when the body leaves it out (also what lets a new column join a table with rows). */
  default(value: z.input<I>): Field<K, C, I, O, Opt, true> {
    return new Field(this.kind, this.makeColumn, this.input, this.output, {
      ...this.options,
      hasDefault: true,
      defaultValue: value,
    });
  }

  /** Unique per tenant (a unique index on the tenant and the column): a duplicate is a 409. */
  unique(): Field<K, C, I, O, Opt, Def> {
    return new Field(this.kind, this.makeColumn, this.input, this.output, {
      ...this.options,
      unique: true,
    });
  }

  /** Part of the record's full-text search (the `search` capability). */
  searchable(): Field<K, C, I, O, Opt, Def> {
    return new Field(this.kind, this.makeColumn, this.input, this.output, {
      ...this.options,
      searchable: true,
    });
  }
}

/** Any field, whatever its types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyField = Field<
  FieldKind,
  any,
  z.ZodType,
  z.ZodType,
  boolean,
  boolean
>;
/** A record's fields, by name (camelCase: the column is snake_case). */
export type Fields = Record<string, AnyField>;

const plain = <
  K extends FieldKind,
  C,
  I extends z.ZodType,
  O extends z.ZodType,
>(
  kind: K,
  makeColumn: (name: string) => C,
  input: I,
  output: O,
  extra: Omit<Partial<AnyField['options']>, 'optional' | 'hasDefault'> = {},
) =>
  new Field<K, C, I, O, false, false>(kind, makeColumn, input, output, {
    optional: false,
    hasDefault: false,
    ...extra,
  });

/** `dueOn` → `due_on`: a field's column name. */
export const columnName = (name: string) =>
  name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The field types. Each one's column, input and output, in one place. */
export const field = {
  /** Short text, trimmed, 1 to `max` characters (200). */
  string: (max = 200) =>
    plain(
      'string',
      (name) => text(columnName(name)),
      z.string().trim().min(1).max(max),
      z.string(),
    ),
  /** Long text, up to `max` characters (10 000). */
  text: (max = 10_000) =>
    plain(
      'text',
      (name) => text(columnName(name)),
      z.string().max(max),
      z.string(),
    ),
  /** A whole number. */
  int: () =>
    plain(
      'int',
      (name) => integer(columnName(name)),
      z.number().int(),
      z.number().int(),
    ),
  /** An exact decimal (rates, quantities), a string end to end: never money (docs/money.md). */
  decimal: () =>
    plain(
      'decimal',
      (name) => numeric(columnName(name)),
      decimalSchema,
      z.string(),
    ),
  /** An amount: minor units and its currency in two columns, `{ amount, currency }` in the API. */
  money: () =>
    new Field<
      'money',
      never,
      typeof moneySchema,
      typeof moneyResponseSchema,
      false,
      false
    >('money', null, moneySchema, moneyResponseSchema, {
      optional: false,
      hasDefault: false,
    }),
  /** Yes or no; false unless sent. */
  bool: () =>
    new Field(
      'bool',
      (name: string) => boolean(columnName(name)),
      z.boolean(),
      z.boolean(),
      {
        optional: false as const,
        hasDefault: true as const,
        defaultValue: false,
      },
    ),
  /** A calendar day, `2026-01-31`, no time zone. */
  date: () =>
    plain(
      'date',
      (name) => date(columnName(name), { mode: 'string' }),
      z.iso.date(),
      z.iso.date(),
    ),
  /** A point in time (timestamptz, UTC in the API). */
  datetime: () =>
    plain(
      'datetime',
      (name) =>
        timestamp(columnName(name), { withTimezone: true, mode: 'date' }),
      z.iso.datetime(),
      z.iso.datetime(),
    ),
  /** One of a fixed list of values. */
  enum: <const V extends readonly [string, ...string[]]>(values: V) =>
    plain(
      'enum',
      (name) => text(columnName(name)).$type<V[number]>(),
      z.enum(values),
      z.enum(values),
      { values },
    ),
  /** A JSON object. */
  json: () =>
    plain(
      'json',
      (name) => jsonb(columnName(name)).$type<Record<string, unknown>>(),
      z.record(z.string(), z.unknown()),
      z.record(z.string(), z.unknown()),
    ),
  /**
   * A record of another feature, in the same tenant (a composite key: never
   * another tenant's). Its list entry says the values are ids of that
   * record's subject; `subject` names it when the target is a hand-written
   * table, not a record's (`field.ref(() => notes, 'Note')`).
   */
  ref: (target: () => Referenced, subject?: string) =>
    plain('ref', (name) => uuid(columnName(name)), z.uuid(), z.uuid(), {
      ref: target,
      ...(subject && { refSubject: subject }),
    }),
};
