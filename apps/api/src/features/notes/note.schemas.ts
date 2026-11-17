import { z } from 'zod';
import { recordSchemas } from '../../platform/records/record.schemas.js';
import { NOTE } from './note.record.js';
import type { notes } from './notes.tables.js';

const DERIVED = recordSchemas(NOTE);

/**
 * The API's schemas of notes, from note.record.ts: create, update, response, bulk.
 * The response leaves `body` optional: it is left out when the reader's
 * permissions don't include it (a field-level permission, note.policy.ts),
 * which a derived response does not say.
 */
export const NOTE_SCHEMAS = {
  ...DERIVED,
  response: DERIVED.response.extend({
    body: z
      .string()
      .optional()
      .describe(
        "Left out when your permissions don't include the note's text.",
      ),
  }),
} as unknown as typeof DERIVED;
export type CreateNoteDto = z.infer<typeof NOTE_SCHEMAS.create>;
export type UpdateNoteDto = z.infer<typeof NOTE_SCHEMAS.update>;

/** A note as stored; the API shows it through RecordPresenter. */
export type Note = typeof notes.$inferSelect;
