import { defineResource } from '../../iam/resources/resource.js';
import { defineCustomFields } from '../../platform/custom-fields/custom-field.types.js';
import type { Note } from './note.schemas.js';
import { notes } from './notes.tables.js';

/**
 * Notes: every create, update, delete and restore is audited (note.created,
 * note.updated…); a custom value's change shows as `custom.<key>`. Deleted
 * notes go to a recycle bin (soft delete).
 */
export const NOTE = defineResource({
  subject: 'Note',
  // The search vector follows the text: not a change of its own.
  audit: { expand: ['custom'], ignore: ['search'] },
  // DELETE moves a note to the recycle bin; restore brings it back; purged after the retention.
  softDelete: { table: notes },
});

/** What a note's revisions keep (platform/revisions): the fields a person changes. */
export const noteSnapshot = (note: Note) => ({
  title: note.title,
  body: note.body,
  custom: note.custom,
});

/** Notes take custom fields (PlatformModule.forRoot): values in notes.custom. */
export const NOTE_CUSTOM_FIELDS = defineCustomFields({
  subject: 'Note',
  table: notes,
  column: notes.custom,
});
