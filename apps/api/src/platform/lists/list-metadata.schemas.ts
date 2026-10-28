import { z } from 'zod';
import { documentTemplateSchema } from '../documents/document.schemas.js';
import { FILTER_OPS } from '../../core/http/list-query.js';
import type { Capability } from '../records/record.js';

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
      "What the field's values are ids of, for a picker instead of a text box: `tag` (GET /v1/tags), `unit` (GET /v1/organizational-units: search with `q`, name ids with `id=`), `principal` (a user's or an API client's key, `user:<id>` or `client:<id>`: GET /v1/people searches users with `q`, names keys with `key=`) or a record's subject (`Invoice`: GET its list). Absent for any other field.",
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

/** What each record capability (record.ts, CAPABILITIES) turns on, and approvals. */
const CAPABILITY_DOCS = {
  tags: 'Tags on the records (`…/{id}/tags`) and the `tag` filter.',
  comments: 'Comments and @mentions (`…/{id}/comments`).',
  attachments:
    'Files on the records (`…/{id}/attachments`); what a file may be is `attachmentLimits`.',
  revisions: 'History, diff and restore (`…/{id}/revisions`).',
  pdf: 'A PDF of a record (`…/{id}/pdf`). False when this deployment has no Gotenberg (the routes answer 503).',
  bulk: 'Many records at once (`…/bulk`).',
  watch:
    'Watching a record (`…/{id}/watch`): its watchers are told of changes.',
  search: '`q=` on the list, and the records in GET /v1/search.',
  transfer: 'Exports and imports (POST /v1/data/exports, /v1/data/imports).',
  custom:
    'Custom fields (GET /v1/custom-fields?subject=…): `custom.<key>` in the list.',
  events:
    'Webhook events of its changes (`<item>.created`…). False with WEBHOOKS=off.',
  numbered: 'A human-readable number (`number`, `INV-2026-00042`).',
  share:
    'Read-only links to a record (`…/{id}/shares`), opened without a sign-in (POST /v1/shared/open).',
  approvals: 'An action on the records may need approval (GET /v1/approvals).',
} satisfies Record<Capability | 'approvals', string>;

/** Which record panels and routes a subject has, in this deployment. */
export const listCapabilitiesSchema = z
  .object(
    Object.fromEntries(
      Object.entries(CAPABILITY_DOCS).map(([name, description]) => [
        name,
        z.boolean().describe(description),
      ]),
    ) as Record<keyof typeof CAPABILITY_DOCS, z.ZodBoolean>,
  )
  .describe(
    "What the subject's records take, from their declaration (`<item>.record.ts`): a client shows a record's panels (comments, attachments, tags, revisions, PDF, approvals…) only where they are true. Whether the caller may use one on a record is the record's `can` (`?include=can`) and the routes' answers.",
  );

/** What an attachment may be (ATTACHMENT_MAX_MB, ATTACHMENT_ALLOWED_TYPES). */
export const attachmentLimitsSchema = z
  .object({
    maxBytes: z
      .number()
      .int()
      .describe(
        'The largest file, in bytes (ATTACHMENT_MAX_MB × 1024²): larger is a 413 `payload_too_large`.',
      )
      .meta({ example: 26_214_400 }),
    maxMb: z
      .number()
      .int()
      .describe('The same, in MB (ATTACHMENT_MAX_MB).')
      .meta({ example: 25 }),
    types: z
      .array(z.string())
      .describe(
        'The types a file may be (ATTACHMENT_ALLOWED_TYPES), recognized from its bytes: another is a 415 `unsupported_media_type`.',
      )
      .meta({ example: ['image/png', 'application/pdf', 'text/plain'] }),
  })
  .nullable()
  .describe(
    "What a record's attachment may be, as the upload route enforces it; null when the subject takes no attachments.",
  );

/**
 * The record views a subject declares (`views` of its record or list
 * source), each naming list fields: a board of an enum field's values, a
 * calendar of date fields, a timeline of a start and an end.
 */
export const listViewsSchema = z
  .object({
    board: z
      .object({
        field: z
          .string()
          .describe("The enum field whose values are the board's columns.")
          .meta({ example: 'status' }),
        readOnly: z
          .boolean()
          .describe(
            'The cards are not moved: the field is not changed through `PATCH`.',
          ),
      })
      .optional(),
    calendar: z
      .object({
        fields: z
          .array(z.string())
          .describe(
            'The `date` (all-day) and `datetime` fields to plan by, one at a time.',
          )
          .meta({ example: ['dueAt'] }),
        readOnly: z
          .boolean()
          .describe('The dates are not changed through `PATCH`.'),
      })
      .optional(),
    timeline: z
      .object({
        start: z.string().describe('The field a bar starts at.'),
        end: z
          .string()
          .describe('The field a bar ends at; empty: the bar is still open.'),
      })
      .optional(),
  })
  .nullable()
  .describe(
    'The views besides the table that this subject declares and this caller can use: a field they may not filter by leaves its view out. Null when none. Fetch their records with the list route, bounded by `filter` on the fields named here.',
  );

/** What a record or list source declares as `views` (readOnly defaults to false). */
export interface ListViewsDeclaration {
  board?: { field: string; readOnly?: boolean };
  calendar?: { fields: readonly string[]; readOnly?: boolean };
  timeline?: { start: string; end: string };
}

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
  capabilities: listCapabilitiesSchema,
  views: listViewsSchema,
  attachmentLimits: attachmentLimitsSchema,
  documentTemplates: z
    .array(documentTemplateSchema)
    .nullable()
    .describe(
      "The templates its records' PDFs are issued from, one item per template and language (POST …/{id}/pdf `?lang=`): what a picker offers. Null when `capabilities.pdf` is false (no PDF capability, or documents off: GOTENBERG_URL unset).",
    ),
});

export type ListField = z.infer<typeof listFieldSchema>;
export type ListMetadata = z.infer<typeof listMetadataSchema>;
export type ListCapabilities = z.infer<typeof listCapabilitiesSchema>;
