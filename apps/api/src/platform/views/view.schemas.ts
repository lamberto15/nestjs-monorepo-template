import { z } from 'zod';
import { pageSchema } from '../../core/http/pagination.js';
import { VIEW_VISIBILITIES } from './views.tables.js';

/** At most this many parameters in a view's query, and this many columns. */
export const MAX_QUERY_KEYS = 40;
export const MAX_COLUMNS = 100;

const query = z
  .record(z.string().min(1).max(100), z.string().max(20_000))
  .refine((value) => Object.keys(value).length <= MAX_QUERY_KEYS, {
    message: `At most ${MAX_QUERY_KEYS} parameters.`,
  })
  .describe(
    "The list's query parameters as its route takes them: flat filters (`status`, `title.contains`), `filter` (the JSON tree as a string), `sort`, `q`. Never paging (`limit`, `cursor`, `page`, `count`), `fields`, `deleted` or `lang`.",
  )
  .meta({ example: { status: 'draft', sort: '-createdAt' } });

const columns = z
  .array(z.string().min(1).max(100))
  .max(MAX_COLUMNS)
  .describe(
    "The item fields to show, in order: the list's `select` (`GET /v1/lists/{subject}`). Null: the list's own.",
  );

const name = z.string().trim().min(1).max(200).meta({ example: 'My drafts' });

/** A saved view. */
export const viewSchema = z
  .object({
    id: z.string(),
    subject: z.string().meta({ example: 'Note' }),
    name,
    visibility: z.enum(VIEW_VISIBILITIES),
    teamId: z.string().nullable().describe('Set for a `team` view.'),
    owner: z
      .string()
      .describe(
        '`user:<id>` or `client:<id>`; `anonymous` once its owner’s account is gone.',
      ),
    mine: z.boolean().describe('You own it.'),
    editable: z
      .boolean()
      .describe('You may change and delete it (its owner, or a view manager).'),
    query,
    columns: columns.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SavedView' });

/** A page of saved views (`GET /v1/views`). */
export const viewPageSchema = pageSchema(viewSchema).meta({
  id: 'SavedViewPage',
});

/** `GET /views/{id}/apply`: the view ready to use on its list route. */
export const viewAppliedSchema = z
  .object({
    view: viewSchema.describe('The view, its columns as you may see them.'),
    params: z
      .record(z.string(), z.string())
      .describe(
        "Send these as the query of the subject's list route: the view's query, and `fields=` for its columns.",
      ),
    columns: columns
      .nullable()
      .describe('The columns you may see, in the view’s order.'),
    hiddenColumns: z
      .array(z.string())
      .describe(
        'Columns of the view your field permissions hide: left out, not an error.',
      ),
  })
  .meta({ id: 'SavedViewApplied' });

const teamId = z
  .uuid()
  .describe('For `visibility: "team"`: a team you belong to.');

/** Body of `POST /views`. */
export const createViewSchema = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(80)
      .describe('The list: a subject `GET /v1/lists/{subject}` describes.')
      .meta({ example: 'Note' }),
    name,
    visibility: z.enum(VIEW_VISIBILITIES).default('private'),
    teamId: teamId.optional(),
    query: query.default({}),
    columns: columns.nullable().default(null),
  })
  .refine((dto) => (dto.visibility === 'team') === (dto.teamId !== undefined), {
    path: ['teamId'],
    message: 'teamId goes with visibility "team", and only with it.',
  });
export type CreateViewDto = z.infer<typeof createViewSchema>;

/** Body of `PATCH /views/{id}`: only what is sent changes (the subject never does). */
export const updateViewSchema = z.object({
  name: name.optional(),
  visibility: z.enum(VIEW_VISIBILITIES).optional(),
  teamId: teamId.nullable().optional(),
  query: query.optional(),
  columns: columns.nullable().optional(),
});
export type UpdateViewDto = z.infer<typeof updateViewSchema>;
