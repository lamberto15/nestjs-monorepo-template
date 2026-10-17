import { z } from 'zod';
import {
  customValuesInputSchema,
  customValuesSchema,
} from '../../platform/custom-fields/custom-field.schemas.js';
import { bulkRequestSchema } from '../../platform/bulk/bulk.schemas.js';
import { recordCanSchema } from '../../platform/records/record-can.js';
import { tagRefSchema } from '../../platform/tags/tag.schemas.js';
import type { notes } from './notes.tables.js';

/**
 * The example feature: notes that an API client or a user writes,
 * published by a durable workflow after a delay (or at once, when the
 * example sender's webhook asks). Replace the notes/ folder with your own
 * features, keeping the shape: schemas, events, service, policy, controller.
 */

export const NOTE_STATUSES = ['draft', 'published'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** Body of `POST /notes`. Bounded, so Swagger's sample request is valid. */
export const createNoteSchema = z.object({
  title: z.string().trim().min(1).max(200).meta({ example: 'Hello' }),
  body: z.string().max(10_000).meta({ example: 'My first note.' }),
  // Checked against the active custom fields of Note by NotesService.
  custom: customValuesInputSchema.optional(),
});
export type CreateNoteDto = z.infer<typeof createNoteSchema>;

/** Body of `PATCH /notes/{id}`: only what is sent changes. */
export const updateNoteSchema = createNoteSchema.partial();
export type UpdateNoteDto = z.infer<typeof updateNoteSchema>;

/** Body of `POST /notes/bulk`: an action on many notes (NoteBulk). */
export const noteBulkSchema = bulkRequestSchema(
  ['delete', 'restore', 'update'],
  updateNoteSchema,
);
export type NoteBulkDto = z.infer<typeof noteBulkSchema>;

export const noteSchema = z.object({
  id: z.string(),
  number: z
    .string()
    .nullable()
    .describe('The number people quote: NOTE-<year>-<n>, given on create.'),
  ownerId: z.string().describe('Who wrote it: `user:<id>` or `client:<id>`.'),
  teamId: z.uuid().nullable().describe("The author's team."),
  title: z.string(),
  body: z
    .string()
    .optional()
    .describe("Left out when your permissions don't include the note's text."),
  status: z.enum(NOTE_STATUSES),
  custom: customValuesSchema
    .optional()
    .describe(
      "Custom field values by key; left out when your permissions don't include them.",
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso
    .datetime()
    .nullable()
    .describe('Set while the note is in the recycle bin (`?deleted=true`).'),
  deletedBy: z
    .string()
    .nullable()
    .describe('Who deleted it: `user:<id>` or `client:<id>`.'),
  publishedAt: z.iso.datetime().nullable(),
  tags: z
    .array(tagRefSchema)
    .describe('Its tags, by name (PUT /v1/notes/{id}/tags sets them).'),
  can: recordCanSchema(true),
});

/** A note as stored (dates as Date); the API sends them as ISO strings (noteSchema). */
export type Note = typeof notes.$inferSelect;

/**
 * A note as the API shows it (before its tags, custom values and
 * redaction): without the search vector the database keeps, nor its tenant,
 * the request's own (docs/tenancy.md).
 */
export const noteView = ({
  search: _search,
  tenantId: _tenantId,
  ...note
}: Note) => note;
