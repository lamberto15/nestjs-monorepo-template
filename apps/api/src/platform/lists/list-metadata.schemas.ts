import { z } from 'zod';
import { FILTER_OPS } from '../../core/http/list-query.js';

/** One field of a list: what it may be filtered and sorted by. */
export const listFieldSchema = z.object({
  name: z
    .string()
    .describe(
      'The name in the query: `?<name>.<operator>=`, `{ "field": <name> }` in `filter`, `sort=<name>`. Custom fields are `custom.<key>`.',
    )
    .meta({ example: 'status' }),
  type: z
    .enum(['string', 'uuid', 'datetime', 'date', 'number', 'boolean', 'enum'])
    .describe(
      'How values are written: datetime ISO 8601 with an offset, date YYYY-MM-DD, enum one of `options`.',
    ),
  options: z
    .array(z.string())
    .optional()
    .describe('The values an enum takes.')
    .meta({ example: ['draft', 'published'] }),
  operators: z
    .array(z.enum(FILTER_OPS))
    .describe('The operators it may be filtered with; empty: none.')
    .meta({ example: ['eq', 'ne', 'in', 'notIn'] }),
  ref: z
    .string()
    .optional()
    .describe(
      "What the field's values are ids of, for a picker instead of a text box: `tag` (GET /v1/tags), `team` (GET /v1/access/teams), `principal` (a user's or an API client's key, `user:<id>` or `client:<id>`) or a record's subject (`Invoice`: GET its list). Absent for any other field.",
    )
    .meta({ example: 'tag' }),
  sortable: z.boolean().describe('`sort` may name it.'),
  custom: z
    .boolean()
    .describe("A custom field of the caller's tenant (GET /v1/custom-fields)."),
  label: z
    .string()
    .optional()
    .describe("A custom field's label, as its administrators named it."),
});

/** What GET /v1/lists/{subject} answers. */
export const listMetadataSchema = z.object({
  subject: z.string().meta({ example: 'Note' }),
  fields: z
    .array(listFieldSchema)
    .describe(
      'The fields the list may be filtered or sorted by, as this caller may read them: a field their permissions hide is not here; one they may read on some records only has no operators and is not sortable (still in `select`).',
    ),
  select: z
    .array(z.string())
    .describe('What `fields=` may pick (id always comes).')
    .meta({ example: ['title', 'status', 'custom.region'] }),
  search: z
    .boolean()
    .describe(
      '`q=` searches the text, and `sort=-rank` puts the best match first. False when the search reads a field this caller may not read on every record.',
    ),
  recycleBin: z
    .boolean()
    .describe(
      '`deleted=true` lists the recycle bin for this caller (they may restore).',
    ),
  defaultSort: z
    .string()
    .nullable()
    .describe('The order without `sort`: the newest first.')
    .meta({ example: '-createdAt' }),
  limits: z
    .object({
      defaultLimit: z
        .number()
        .int()
        .describe('Rows a page holds without `limit`.'),
      maxLimit: z.number().int().describe('The largest `limit`.'),
      maxOffset: z
        .number()
        .int()
        .describe(
          'No `page` starts past this row: narrow the filters, or page by cursor.',
        ),
      countCap: z
        .number()
        .int()
        .describe('`count=true` counts up to this (then `totalCapped`).'),
      maxSort: z.number().int().describe('Fields `sort` may name.'),
      maxConditions: z.number().int().describe('Conditions in one `filter`.'),
      maxDepth: z.number().int().describe('Groups nested in one `filter`.'),
      maxValues: z.number().int().describe('Values of one `in` or `notIn`.'),
    })
    .describe("The list's limits, the same on every list."),
});

export type ListField = z.infer<typeof listFieldSchema>;
export type ListMetadata = z.infer<typeof listMetadataSchema>;
