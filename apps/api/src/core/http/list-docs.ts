import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import type { List } from './list-query.js';

/** The OpenAPI 3.0 schema of a value, as @nestjs/swagger puts it in a document. */
type ParamSchema = Record<string, unknown> & { description?: string };

/** The largest integer JavaScript holds: what zod's `.int()` adds as a bound. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * What a query parameter takes, from its own schema: the Standard JSON Schema
 * of its INPUT (what a client sends, OpenAPI 3.0), the same conversion
 * `@Query({ schema })` documents with. So `limit` is an integer with its
 * bounds and default, a flat enum filter lists its values, a date filter is a
 * `date-time`: documentation can't drift from what `listQuery()` accepts.
 */
function inputSchema(schema: unknown): ParamSchema {
  const standard = (
    schema as {
      '~standard'?: {
        jsonSchema?: {
          input?: (options: { target: string }) => ParamSchema;
        };
      };
    }
  )['~standard'];
  const json = standard?.jsonSchema?.input?.({ target: 'openapi-3.0' });
  if (!json) {
    // A schema that can't tell (not Standard JSON Schema): a plain string, as the wire has it.
    return { type: 'string' };
  }
  // The regular expression zod adds to a format (`uuid`, `date-time`) only
  // clutters the document: the format says it. Same for the safe-integer
  // bounds `.int()` adds.
  const { pattern: _pattern, ...rest } = json;
  const clean: ParamSchema = typeof json.format === 'string' ? rest : json;
  if (clean.maximum === MAX_SAFE) {
    delete clean.maximum;
  }
  if (clean.minimum === -MAX_SAFE) {
    delete clean.minimum;
  }
  return clean;
}

/**
 * Documents a list's query parameters (filters, filter, sort, fields, the
 * page) from its declaration, for a route that validates them itself with
 * `list.parse()` (a list extended per request: custom fields). Each is typed
 * by its schema's input (`limit` an integer, a flat enum filter its values):
 * see `inputSchema`. Fields added at runtime aren't known here: the
 * description says where they come from.
 */
export function ApiListQuery(list: List, runtime?: string) {
  return applyDecorators(
    ...Object.entries(list.shape).map(([name, schema]) => {
      const { description, ...type } = inputSchema(schema);
      return ApiQuery({
        name,
        required: false,
        description:
          description ??
          (name === 'lang' ? 'The language of the answer.' : undefined),
        schema: type,
      });
    }),
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
