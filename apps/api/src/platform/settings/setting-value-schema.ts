import { z } from 'zod';

/** The kind of input a setting's value takes, for a client to pick its control. */
export const SETTING_VALUE_TYPES = [
  'boolean',
  'number',
  'string',
  'enum',
  'json',
] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];

/**
 * What a setting's value must be, as GET /v1/settings tells it: the simple
 * description a form needs (`type`, `options`, inclusive bounds, the
 * longest string) and the whole JSON Schema (`schema`) for anything the
 * simple one doesn't say (a pattern, exclusive bounds, an object's shape).
 */
export interface SettingValueSchema {
  type: SettingValueType;
  /** `enum`: the values it takes. */
  options?: (string | number)[];
  /** `number`: the smallest value it takes. */
  min?: number;
  /** `number`: the largest value it takes. */
  max?: number;
  /** `number`: whole numbers only. */
  integer?: boolean;
  /** `string`: the most characters it takes. */
  maxLength?: number;
  /** The value's JSON Schema (draft 2020-12), from the declaration's Zod schema. */
  schema: Record<string, unknown>;
}

type Json = Record<string, unknown>;

const primitive = (value: unknown): value is string | number =>
  typeof value === 'string' || typeof value === 'number';

/** Zod writes an unbounded `int()` with the safe-integer bounds: no bound to show. */
const bound = (value: unknown) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) < Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

/**
 * A setting's value schema, derived from its declaration's Zod schema with
 * Zod's own `z.toJSONSchema()` (the input side: what a client sends), never
 * written by hand, so it can't drift from what PUT checks. What JSON
 * Schema can't express (a transform, a refinement) is left out of
 * `schema`, as `unrepresentable: 'any'` does; PUT still checks it (400
 * `validation_failed`). The simple fields read the JSON Schema: a type
 * none of them covers (an object, a union, a nullable value) is `json`.
 */
export function settingValueSchema(schema: z.ZodType): SettingValueSchema {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Json;
  const options = enumOptions(json);
  if (options) {
    return { type: 'enum', options, schema: json };
  }
  switch (json.type) {
    case 'boolean':
      return { type: 'boolean', schema: json };
    case 'integer':
    case 'number': {
      const min = bound(json.minimum);
      const max = bound(json.maximum);
      return {
        type: 'number',
        ...(min !== undefined && { min }),
        ...(max !== undefined && { max }),
        ...(json.type === 'integer' && { integer: true }),
        schema: json,
      };
    }
    case 'string':
      return {
        type: 'string',
        ...(typeof json.maxLength === 'number' && {
          maxLength: json.maxLength,
        }),
        schema: json,
      };
    default:
      return { type: 'json', schema: json };
  }
}

/** `z.enum([...])` (`enum`) or a union of literals (`anyOf` of `const`): its values. */
function enumOptions(json: Json): (string | number)[] | undefined {
  if (
    Array.isArray(json.enum) &&
    json.enum.length > 0 &&
    json.enum.every(primitive)
  ) {
    return json.enum;
  }
  const anyOf = json.anyOf;
  if (
    Array.isArray(anyOf) &&
    anyOf.length > 0 &&
    anyOf.every((branch: Json) => primitive(branch?.const))
  ) {
    return anyOf.map((branch: Json) => branch.const as string | number);
  }
  return undefined;
}
