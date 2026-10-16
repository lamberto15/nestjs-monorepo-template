import { sql, type SQL } from 'drizzle-orm';
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
 * - A multiSelect takes `in` (holds any of, on the GIN index) and `isNull`.
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
    const ops = (all: readonly FilterOp[]) => (field.filterable ? all : []);
    const choices = (field.options ?? []).map((option) => option.value);
    switch (field.type) {
      case 'number':
        fields[name] = {
          column: expression,
          type: 'number',
          ops: ops([...ORDERED_FILTER_OPS, 'in', 'notIn']),
          sortable: field.sortable,
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
          };
          break;
        }
        const key = keyLiteral(field.key);
        fields[name] = {
          column: expression,
          type: 'enum',
          values,
          ops: ops(['in', 'isNull']),
          sortable: false, // an array has no useful order
          conditions: {
            // Holds any of the values: `?|` on the GIN index.
            in: (value) =>
              sql`(${column}->${key}) ?| array[${sql.join(
                (value as string[]).map((item) => sql`${item}`),
                sql`, `,
              )}]::text[]`,
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
        };
    }
  }
  return { fields, select };
}
