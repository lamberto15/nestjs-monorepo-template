import type { z } from 'zod';
import { recordSchemas } from '../../platform/records/record.schemas.js';
import { NOTE } from './note.record.js';
import type { notes } from './notes.tables.js';

/** The API's schemas of notes, from note.record.ts: create, update, response, bulk. */
export const NOTE_SCHEMAS = recordSchemas(NOTE);
export type CreateNoteDto = z.infer<typeof NOTE_SCHEMAS.create>;
export type UpdateNoteDto = z.infer<typeof NOTE_SCHEMAS.update>;

/** A note as stored; the API shows it through RecordPresenter. */
export type Note = typeof notes.$inferSelect;
