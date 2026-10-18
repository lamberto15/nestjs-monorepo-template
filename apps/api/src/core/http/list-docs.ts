import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import type { List } from './list-query.js';

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
        type: String,
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
