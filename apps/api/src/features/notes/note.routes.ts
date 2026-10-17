import type { RecordRouteSpec } from '../../platform/records/record-routes.js';

/**
 * Notes' record-level routes, as the platform builds them (record-routes.ts):
 * /v1/notes/{id}/tags, comments, attachments, revisions, pdf, watch, and
 * /v1/notes/bulk. notes.module.ts lists the controllers.
 */
export const NOTE_ROUTES: RecordRouteSpec = {
  subject: 'Note',
  path: 'notes',
  apiTag: 'notes',
  className: 'Note',
  noun: 'note',
};
