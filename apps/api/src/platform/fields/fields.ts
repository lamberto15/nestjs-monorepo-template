import { randomInt, randomUUID } from 'node:crypto';
import {
  sql,
  type ColumnBuilderBase,
  type HasDefault,
  type NotNull,
} from 'drizzle-orm';
import { bigint, char, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ExtraConfigColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenantReference } from '../../core/tenancy/tenant-scope.js';
import {
  type MoneyColumns,
  moneyColumns,
  moneyOf,
  moneyValues,
} from '../money/money.columns.js';
import { Money } from '../money/money.js';
import type { moneyResponseSchema } from '../money/money.schemas.js';
import { type AnyField, columnName, type Field, type Fields } from './field.js';

/**
 * What a record's fields (field.ts) derive: its columns, its table's indexes
 * and keys, its API schemas, how a body becomes column values and a row its
 * API view, its revisions' snapshot, sample values for tests. Every feature
 * declares fields once and reads the rest from here, so a change to a type
 * reaches them all. No Nest here either: the tables import it.
 */

// The money pair's builders, as moneyColumns() makes them (money.columns.ts).
const moneyPair = (name: string) => ({
  minor: bigint(`${columnName(name)}_minor`, { mode: 'bigint' }),
  currency: char(`${columnName(name)}_currency`, { length: 3 }),
});
type MoneyOptional = ReturnType<typeof moneyPair>;
type MoneyRequired = {
  minor: NotNull<MoneyOptional['minor']>;
  currency: NotNull<MoneyOptional['currency']>;
};

type UnionToIntersection<U> = (
  U extends unknown ? (union: U) => void : never
) extends (intersection: infer I) => void
  ? I
  : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** One field's columns: money its pair; the others one column, NOT NULL unless optional. */
type ColumnsOf<N extends string, F> =
  F extends Field<'money', never, z.ZodType, z.ZodType, infer Opt, boolean>
    ? MoneyColumns<N, Opt extends true ? MoneyOptional : MoneyRequired>
    : F extends Field<
          infer _K,
          infer C,
          z.ZodType,
          z.ZodType,
          infer Opt,
          infer Def
        >
      ? C extends ColumnBuilderBase
        ? {
            [P in N]: Def extends true
              ? Opt extends true
                ? HasDefault<C>
                : HasDefault<NotNull<C>>
              : Opt extends true
                ? C
                : NotNull<C>;
          }
        : never
      : never;

/** Every field's columns, as one object to spread into `pgTable(…, { …, ...fieldColumns(F) })`. */
export type FieldColumns<F extends Fields> = Simplify<
  UnionToIntersection<
    { [N in keyof F & string]: ColumnsOf<N, F[N]> }[keyof F & string]
  >
>;

/** The columns of the fields, to spread into the table. */
export function fieldColumns<F extends Fields>(fields: F): FieldColumns<F> {
  const columns: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(fields)) {
    const { optional, hasDefault, defaultValue } = f.options;
    if (f.kind === 'money') {
      Object.assign(
        columns,
        optional ? moneyColumns(name, { nullable: true }) : moneyColumns(name),
      );
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let column = f.makeColumn!(name) as any;
    if (!optional) column = column.notNull();
    if (hasDefault) column = column.default(defaultValue);
    columns[name] = column;
  }
  return columns as FieldColumns<F>;
}

/**
 * The table's indexes and keys the fields need, for the table's extras:
 * a unique field's per-tenant unique index, a reference's index and its key
 * within the tenant (tenantReference: never another tenant's record).
 */
export function fieldExtras(
  tableName: string,
  table: Record<string, ExtraConfigColumn>,
  fields: Fields,
  softDelete = false,
) {
  const extras = [];
  for (const [name, f] of Object.entries(fields)) {
    const column = `${tableName}_${columnName(name)}`;
    if (f.options.unique) {
      const unique = uniqueIndex(`${column}_idx`).on(
        table.tenantId!,
        table[name]!,
      );
      // A record in the recycle bin keeps its row but not its value: only
      // live rows are unique (docs/adding-a-feature.md, soft delete).
      extras.push(softDelete ? unique.where(sql`deleted_at is null`) : unique);
    }
    if (f.options.ref) {
      const target = f.options.ref;
      // Leads with the tenant, then newest first: a record's related list
      // (`?<x>Id=`, record-relations.ts) is one bounded range of it, and the
      // key's checks on delete use it too (so not partial).
      extras.push(
        index(`${column}_idx`).on(
          table.tenantId!,
          table[name]!,
          table.id!.desc().nullsFirst(),
        ),
      );
      extras.push(
        tenantReference(
          `${column}_fk`,
          [table.tenantId!, table[name]!],
          [target().tenantId, target().id],
          // An optional one is emptied by the platform before its record goes
          // for good (emptyReferences), checked at the statement's end.
          f.options.optional ? 'no action' : 'restrict',
        ),
      );
    }
  }
  return extras;
}

/** One field's input in a create body: optional ones take null or nothing, defaulted ones nothing. */
type InputOf<F> =
  F extends Field<infer _K, infer _C, infer I, z.ZodType, infer Opt, infer Def>
    ? Opt extends true
      ? z.ZodOptional<z.ZodNullable<I>>
      : Def extends true
        ? z.ZodOptional<I>
        : I
    : never;
/** One field's output in a response: null when optional. */
type OutputOf<F> =
  F extends Field<infer _K, infer _C, z.ZodType, infer O, infer Opt, boolean>
    ? Opt extends true
      ? z.ZodNullable<O>
      : O
    : never;
export type CreateShape<F extends Fields> = { [N in keyof F]: InputOf<F[N]> };
export type OutputShape<F extends Fields> = { [N in keyof F]: OutputOf<F[N]> };

const inputOf = (f: AnyField) =>
  f.options.optional
    ? f.input.nullable().optional()
    : f.options.hasDefault
      ? f.input.optional()
      : f.input;
const outputOf = (f: AnyField) =>
  f.options.optional ? f.output.nullable() : f.output;

/**
 * The API's schemas of the fields: `create` (POST's body), `update`
 * (PATCH's: only what is sent), and `response` (the fields' part of a
 * record's response shape; the record adds its id, owner and dates).
 */
export function fieldSchemas<F extends Fields>(fields: F) {
  const entries = Object.entries(fields);
  const create = z.object(
    Object.fromEntries(
      entries.map(([name, f]) => [name, inputOf(f)]),
    ) as CreateShape<F>,
  );
  return {
    create,
    update: create.partial(),
    response: Object.fromEntries(
      entries.map(([name, f]) => [name, outputOf(f)]),
    ) as OutputShape<F>,
  };
}

type MoneyNames<F extends Fields> = {
  [N in keyof F & string]: F[N]['kind'] extends 'money' ? N : never;
}[keyof F & string];
/** The columns a money field keeps that the API shows as one object. */
export type MoneyKeys<F extends Fields> =
  `${MoneyNames<F>}Minor` | `${MoneyNames<F>}Currency`;
/** A row as the API shows it: each money pair as `{ amount, currency }`. */
export type FieldView<F extends Fields, Row> = Omit<Row, MoneyKeys<F>> & {
  [N in MoneyNames<F>]: z.output<typeof moneyResponseSchema> | null;
};

/**
 * A body's values as columns, only what was sent: money as minor units and
 * currency (`moneyValues`), a datetime's string as a Date. Cast to the
 * table's insert type by the caller (the shape is the table's by
 * construction).
 */
export function fieldValues(
  fields: Fields,
  dto: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(dto)) {
    const f = fields[name];
    if (value === undefined || !f) {
      if (!f && value !== undefined) values[name] = value; // not a field: the feature's own
      continue;
    }
    if (f.kind === 'money') {
      if (value === null) {
        values[`${name}Minor`] = null;
        values[`${name}Currency`] = null;
      } else {
        const money = value as { amount: string; currency: string };
        Object.assign(
          values,
          moneyValues(name, Money.of(money.amount, money.currency)),
        );
      }
    } else if (f.kind === 'datetime') {
      values[name] = value === null ? null : new Date(value as string);
    } else {
      values[name] = value;
    }
  }
  return values;
}

/** A row as the API shows it (and the audit log records it): each money pair as one object. */
export function fieldView<
  F extends Fields,
  Row extends Record<string, unknown>,
>(fields: F, row: Row): FieldView<F, Row> {
  const view: Record<string, unknown> = { ...row };
  for (const [name, f] of Object.entries(fields)) {
    if (f.kind !== 'money') continue;
    delete view[`${name}Minor`];
    delete view[`${name}Currency`];
    view[name] =
      moneyOf(
        row as unknown as Parameters<typeof moneyOf>[0],
        name,
      )?.toJSON() ?? null;
  }
  return view as FieldView<F, Row>;
}

/** What a revision keeps: the fields, as the API shows them. */
export function fieldSnapshot(fields: Fields, view: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(fields).map((name) => [name, view[name] ?? null]),
  );
}

/** A value of each type a test can send, another one, and one the schema refuses. */
const SAMPLES: Record<
  AnyField['kind'],
  (
    f: AnyField,
    name: string,
  ) => { sample: unknown; changed: unknown; invalid: unknown }
> = {
  string: (f, name) => ({
    sample: f.options.unique
      ? `${name}-${randomUUID().slice(0, 8)}`
      : `${name} 1`,
    changed: f.options.unique
      ? `${name}-${randomUUID().slice(0, 8)}`
      : `${name} 2`,
    invalid: 123,
  }),
  text: () => ({ sample: 'Some text.', changed: 'Other text.', invalid: 123 }),
  int: (f) => ({
    sample: f.options.unique ? randomInt(1e9) : 3,
    changed: f.options.unique ? randomInt(1e9) : 4,
    invalid: 'three',
  }),
  decimal: () => ({ sample: '12.50', changed: '13.75', invalid: 'twelve' }),
  money: () => ({
    sample: { amount: '19.99', currency: 'EUR' },
    changed: { amount: '25.00', currency: 'EUR' },
    invalid: '19.99',
  }),
  bool: () => ({ sample: true, changed: false, invalid: 'yes' }),
  date: () => ({
    sample: '2026-01-31',
    changed: '2026-02-28',
    invalid: '31/01/2026',
  }),
  datetime: () => ({
    sample: '2026-01-31T09:00:00.000Z',
    changed: '2026-02-28T17:30:00.000Z',
    invalid: 'tomorrow',
  }),
  enum: (f) => ({
    sample: f.options.values![0],
    changed: f.options.values![1] ?? f.options.values![0],
    invalid: 'nope',
  }),
  json: () => ({
    sample: { size: 'm' },
    changed: { size: 'l' },
    invalid: 'text',
  }),
  // A reference's record is another feature's: tests leave it empty.
  ref: () => ({ sample: null, changed: null, invalid: 'not-a-uuid' }),
};

/**
 * Sample bodies for the fields, for tests: `body()` valid (unique values
 * fresh on every call), `changed` a valid change of one field, `invalid`
 * a body its schema refuses.
 */
export function fieldSamples(fields: Fields) {
  const entries = Object.entries(fields);
  const body = () =>
    Object.fromEntries(
      entries.map(([name, f]) => [name, SAMPLES[f.kind](f, name).sample]),
    );
  const [first, f] =
    entries.find(([, candidate]) => candidate.kind !== 'ref') ?? entries[0]!;
  const sample = SAMPLES[f.kind](f, first);
  return {
    body,
    changed: { [first]: sample.changed },
    invalid: { [first]: sample.invalid },
    changedField: first,
  };
}

/** The fields part of the text a full-text search reads (`.searchable()`). */
export const searchableFields = (fields: Fields) =>
  Object.entries(fields)
    .filter(([, f]) => f.options.searchable)
    .map(([name]) => name);
