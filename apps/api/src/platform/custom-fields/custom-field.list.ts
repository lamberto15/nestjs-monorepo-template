import { or, sql, type SQL } from 'drizzle-orm';
import type { FilterField, FilterOp } from '../../core/http/list-query.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { CustomFieldDefinition } from './custom-field.types.js';
import { CUSTOM_KEY_PATTERN } from './custom-field.values.js';

/**
 * The key as an SQL string literal. Keys are slugs (CUSTOM_KEY_PATTERN,
 * checked again here), so inlining is safe; a literal rather than a
 * parameter keeps the expression identical from query to query, so an
 * expression index (`((custom->>'region'))`) can serve it.
 */
function keyLiteral(key: string): SQL {
  if (!CUSTOM_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid custom field key: ${key}`);
  }
  return sql.raw(`'${key}'`);
}

/**
 * `column @> {key: value}`: the GIN index (`jsonb_ops`) serves only an
 * operator with the column itself on the left (`@>`, `?`, `?|`), never
 * `column->>'key'`, so equality filters are written as containment. Values
 * are never stored as JSON null (a removed value removes the key), which
 * makes it equal to `=`. Raw SQL: Drizzle has no JSONB containment operator.
 */
function contains(column: AnyPgColumn, key: string, value: SQL): SQL {
  return sql`${column} @> jsonb_build_object(${keyLiteral(key)}, ${value})`;
}

/** `eq` and `in` of one field as containment of a value of this SQL type. */
function equalityConditions(
  column: AnyPgColumn,
  key: string,
  type: 'text' | 'numeric' | 'boolean',
): Pick<Record<FilterOp, (value: unknown) => SQL>, 'eq' | 'in'> {
  // The JSON type of the value must match the stored one ('5' never matches 5).
  const typed = (value: unknown) =>
    type === 'numeric'
      ? sql`${value}::numeric`
      : type === 'boolean'
        ? sql`${value}::boolean`
        : sql`${value}::text`;
  const one = (value: unknown) => contains(column, key, typed(value));
  return {
    eq: one,
    in: (values) => or(...(values as unknown[]).map(one)) as SQL,
  };
}

/** Has a value: the key is present (`?`, on the GIN index); none: its negation. */
function presence(column: AnyPgColumn, key: string) {
  return (value: unknown): SQL =>
    value
      ? sql`not (${column} ? ${keyLiteral(key)})`
      : sql`${column} ? ${keyLiteral(key)}`;
}

/** The typed SQL expression of one field's value. */
export function customFieldExpression(
  column: AnyPgColumn,
  field: Pick<CustomFieldDefinition, 'key' | 'type'>,
): SQL {
  const key = keyLiteral(field.key);
  switch (field.type) {
    case 'number':
      return sql`((${column}->>${key})::numeric)`;
    case 'date':
      return sql`((${column}->>${key})::date)`;
    case 'boolean':
      return sql`((${column}->>${key})::boolean)`;
    case 'multiSelect':
      return sql`(${column}->${key})`;
    default:
      return sql`(${column}->>${key})`;
  }
}

/** Text-like custom values: compared as text, searched with the text operators. */
const TEXT_FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'in',
  'notIn',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isNull',
];
const ORDERED_FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
];

/**
 * A subject's active custom fields as list fields (core/http/list-query.ts),
 * to `extend()` a list with: `custom.<key>` can then be filtered (flat or in
 * `filter`), sorted and picked with `fields` like any declared field.
 *
 * - Filters only on fields marked filterable, sorting only on sortable ones.
 * - On the GIN index: `eq`, `in` and `isNull=false` (containment `@>` and `?`
 *   on the column). The rest (`ne`, `notIn`, ranges, text operators, sorts)
 *   reads the typed expression per row, no index can serve it.
 * - A multiSelect takes `in` (holds any of) and `isNull`.
 * - Every active field can be picked with `fields=custom.<key>`.
 */
export function customFilterFields(
  definitions: readonly CustomFieldDefinition[],
  column: AnyPgColumn,
): { fields: Record<string, FilterField>; select: string[] } {
  const fields: Record<string, FilterField> = {};
  const select: string[] = [];
  for (const field of definitions) {
    if (!field.active) {
      continue;
    }
    const name = `custom.${field.key}`;
    select.push(name);
    if (!field.filterable && !field.sortable) {
      continue;
    }
    const expression = customFieldExpression(column, field);
    const isNull = presence(column, field.key);
    const ops = (all: readonly FilterOp[]) => (field.filterable ? all : []);
    const choices = (field.options ?? []).map((option) => option.value);
    switch (field.type) {
      case 'number':
        fields[name] = {
          column: expression,
          type: 'number',
          ops: ops([...ORDERED_FILTER_OPS, 'in', 'notIn']),
          sortable: field.sortable,
          conditions: {
            ...equalityConditions(column, field.key, 'numeric'),
            isNull,
          },
          // numeric comes back as text: the cursor needs the number.
          select: expression.mapWith(Number),
        };
        break;
      case 'date':
        fields[name] = {
          column: expression,
          type: 'date',
          ops: ops(ORDERED_FILTER_OPS),
          sortable: field.sortable,
          // Stored as the canonical YYYY-MM-DD string: text equality is date equality.
          conditions: {
            eq: equalityConditions(column, field.key, 'text').eq,
            isNull,
          },
          // As stored (YYYY-MM-DD): node-postgres would turn a date into a local-midnight Date.
          select: sql`(${column}->>${keyLiteral(field.key)})`,
        };
        break;
      case 'boolean':
        fields[name] = {
          column: expression,
          type: 'boolean',
          ops: ops(['eq', 'ne', 'isNull']),
          sortable: field.sortable,
          conditions: {
            eq: equalityConditions(column, field.key, 'boolean').eq,
            isNull,
          },
        };
        break;
      case 'select':
      case 'multiSelect': {
        if (!choices.length) {
          continue;
        }
        const values = choices as [string, ...string[]];
        if (field.type === 'select') {
          fields[name] = {
            column: expression,
            type: 'enum',
            values,
            ops: ops(['eq', 'ne', 'in', 'notIn', 'isNull']),
            sortable: field.sortable,
            conditions: {
              ...equalityConditions(column, field.key, 'text'),
              isNull,
            },
          };
          break;
        }
        fields[name] = {
          column: expression,
          type: 'enum',
          values,
          ops: ops(['in', 'isNull']),
          sortable: false, // an array has no useful order
          conditions: {
            // Holds any of the values: containment of a one-element array, on the GIN index.
            in: (value) =>
              or(
                ...(value as string[]).map(
                  (item) =>
                    sql`${column} @> jsonb_build_object(${keyLiteral(field.key)}, jsonb_build_array(${item}::text))`,
                ),
              ) as SQL,
            isNull,
          },
        };
        break;
      }
      default:
        fields[name] = {
          column: expression,
          type: 'string',
          ops: ops(TEXT_FILTER_OPS),
          sortable: field.sortable,
          conditions: {
            ...equalityConditions(column, field.key, 'text'),
            isNull,
          },
        };
    }
  }
  return { fields, select };
}
