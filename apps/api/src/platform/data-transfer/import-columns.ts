import { z } from 'zod';
import type { ImportColumn } from './data-transfer.types.js';
import { localDateTime } from './formats.js';

/** What z.toJSONSchema writes for one property, as far as a column needs it. */
interface JsonProperty {
  type?: string;
  format?: string;
  enum?: unknown[];
  description?: string;
  example?: unknown;
  examples?: unknown[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonProperty;
  anyOf?: JsonProperty[];
}

const typeOf = (property: JsonProperty): ImportColumn['type'] => {
  if (property.format === 'date-time') return 'datetime';
  if (property.format === 'date') return 'date';
  if (property.type === 'number' || property.type === 'integer') {
    return 'number';
  }
  if (property.type === 'boolean') return 'boolean';
  if (property.type === 'array') return 'list';
  return 'text';
};

/** Zod writes Number.MAX_SAFE_INTEGER as an int's bound: no real limit. */
const bound = (value: number | undefined) =>
  value !== undefined && Math.abs(value) < Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

/** The object without its undefined keys (the catalog answers JSON). */
const defined = <T extends object>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

/**
 * The columns of an import's row schema (a z.object), read through
 * z.toJSONSchema on the input side: required unless optional or defaulted,
 * lengths, bounds, choices, `.meta({ example })` and `.describe()`. Another
 * schema (a transform, a union) describes no columns.
 */
export function columnsOf(schema: z.ZodType): ImportColumn[] {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as { properties?: Record<string, JsonProperty>; required?: string[] };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, raw]) => {
    // A nullable value: its non-null branch describes it.
    const branch = raw.anyOf?.find((option) => option.type !== 'null');
    const property = branch ? { ...branch, ...raw, anyOf: undefined } : raw;
    const type = typeOf(property);
    const [min, max] =
      type === 'text'
        ? [property.minLength, property.maxLength]
        : type === 'number'
          ? [property.minimum, property.maximum]
          : type === 'list'
            ? [property.minItems, property.maxItems]
            : [];
    const options = (property.enum ?? property.items?.enum)?.map(String);
    return defined({
      name,
      type,
      required: required.has(name) && property.default === undefined,
      description: property.description,
      options,
      min: bound(min),
      max: bound(max),
      example:
        property.example ??
        property.examples?.[0] ??
        (property.default === '' ? undefined : property.default) ??
        // An optional id (a reference) is left empty: any id a template made
        // up would name no record, and the row would be refused.
        (property.format === 'uuid' && !required.has(name) ? '' : undefined),
    });
  });
}

/**
 * The value a template's example row shows: the column's own example, else
 * one that passes its checks (a date-time as a Date: each format writes it
 * in the reader's zone).
 */
export function exampleOf(
  column: ImportColumn,
  now: Date,
  timeZone: string,
): unknown {
  if (column.example !== undefined) {
    return column.type === 'datetime' && typeof column.example === 'string'
      ? new Date(column.example)
      : column.example;
  }
  const first = column.options?.[0];
  switch (column.type) {
    case 'number':
      return column.min ?? 1;
    case 'boolean':
      return true;
    case 'date':
      return localDateTime(now, timeZone).slice(0, 10);
    case 'datetime':
      return now;
    case 'list':
      return first !== undefined ? [first] : ['text'];
    default:
      return first ?? 'text'.padEnd(column.min ?? 0, 'x');
  }
}
