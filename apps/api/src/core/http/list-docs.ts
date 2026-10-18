import { applyDecorators } from '@nestjs/common';
import { ApiQuery, type SchemaObject } from '@nestjs/swagger';
import type { z } from 'zod';
import type { List } from './list-query.js';

/**
 * A query parameter's schema as `@Query({ schema })` documents it (the
 * Standard JSON Schema input, OpenAPI 3.0: `limit` an integer of 1 to 100,
 * `count` an enum), so a list documented here reads as one validated by
 * its schema; a plain string when the schema has no JSON form.
 */
function parameterSchema(schema: z.ZodType): SchemaObject {
  try {
    const converted = schema['~standard'].jsonSchema?.input({
      target: 'openapi-3.0',
    }) as (SchemaObject & { $schema?: string; $defs?: unknown }) | undefined;
    if (converted && !converted.$defs) {
      const { $schema: _dialect, ...rest } = converted;
      return rest;
    }
  } catch {
    // Not representable (a transform's output): documented as text below.
  }
  return { type: 'string' };
}

/**
 * Documents a list's query parameters (filters, filter, sort, fields, the
 * page) from its declaration, for a route that validates them itself with
 * `list.parse()` (a list extended per request: custom fields). Fields added
 * at runtime aren't known here: the description says where they come from.
 */
export function ApiListQuery(list: List, runtime?: string) {
  return applyDecorators(
    ...Object.entries(list.shape).map(([name, schema]) =>
      ApiQuery({
        name,
        required: false,
        schema: parameterSchema(schema as z.ZodType),
        description:
          (schema as { description?: string }).description ??
          (name === 'lang' ? 'The language of the answer.' : undefined),
      }),
    ),
    ...(runtime
      ? [
          ApiQuery({
            name: 'custom.<key>[.<op>]',
            required: false,
            type: String,
            description: runtime,
          }),
        ]
      : []),
  );
}
