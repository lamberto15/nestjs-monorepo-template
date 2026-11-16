import { recordResource } from '../../platform/records/record-resource.js';
import { NOTE } from './note.record.js';
import { notes } from './notes.tables.js';

/**
 * Notes: every change audited (note.created, note.updated…),
 * a custom value's change as `custom.<key>`, deleted ones in a recycle bin when
 * note.record.ts says softDelete (recordResource).
 */
export const NOTE_RESOURCE = recordResource(NOTE, notes);
