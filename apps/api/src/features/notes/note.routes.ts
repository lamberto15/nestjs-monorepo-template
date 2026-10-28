import type { RecordRouteSpec } from '../../platform/records/record-routes.js';
import type { Capability } from '../../platform/records/record.js';

/**
 * Notes' record-level routes, as the platform builds them (record-routes.ts):
 * /v1/notes/{id}/tags, comments, attachments, revisions, pdf, watch, shares, and
 * /v1/notes/bulk. notes.module.ts lists the controllers.
 */
export const NOTE_ROUTES: RecordRouteSpec = {
  subject: 'Note',
  path: 'notes',
  apiTag: 'notes',
  className: 'Note',
  noun: 'note',
};

/**
 * What notes take, as a generated record's `capabilities` says it
 * (GET /v1/lists/Note answers them): notes.module.ts wires each by hand.
 * A capability added there is added here too.
 */
export const NOTE_CAPABILITIES: readonly Capability[] = [
  'tags',
  'comments',
  'attachments',
  'revisions',
  'pdf',
  'bulk',
  'watch',
  'search',
  'transfer',
  'custom',
  'events',
  'numbered',
  'share',
];

/** What notes' bulk operation offers (NoteBulk, note.bulk.ts). */
export const NOTE_BULK_DOCS = {
  summary: 'Delete, restore or change many notes at once',
  description: [
    'Each note as its own route does it (permissions, field-level checks, audit, webhooks); a note that fails does not stop the others.',
    '',
    '- `ids` (1 to 500): up to BULK_SYNC_LIMIT (100) answer 200 with a result per note; more answer 202.',
    '- `filter` (the list\'s filters, `{ "title.startsWith": "Old" }`): always 202.',
    '',
    "A 202 is a background job: follow it at GET /v1/bulk/{id}; the realtime connection hears `bulk.finished`. Ids you may not act on (or that do not exist) come back `skipped`. `input` is the update's PATCH body.",
  ].join('\n'),
};

/** Who watches a note, and what they hear. */
export const NOTE_WATCH_DOCS = {
  watch: {
    summary: 'Watch a note: be told when it changes or is published',
    description:
      'Its owner watches it from the start. Stop with DELETE /v1/notes/{id}/watch (or /v1/subscriptions/Note/{id}).',
  },
};

/** What notes' revisions hold and a restore sets: a note's own words. */
export const NOTE_REVISION_DOCS = {
  list: {
    description:
      'Revision 1 is the note as written; each change adds one, with what changed (`changes`, from → to). Cursor pages; `?changedBy=user:<id>`, `?number.gte=`. The text and custom values only when your permissions include them.',
  },
  restore: {
    description:
      "Its title, text and custom values become the revision's, as a PATCH would set them (the same permissions, field-level ones too): audited `note.updated`, and a new revision with `restoredFrom`. With If-Match (the note's ETag), refused (412) if the note changed since you read it. Answers the note.",
  },
};

/** What a note's PDF holds. */
export const NOTE_DOCUMENT_DOCS = {
  pdf: {
    description: [
      "Whoever may read the note. Answers at once with the document id; a worker renders the PDF in the request's language (`?lang=`, `X-Lang`, your saved language; right to left in Arabic) and your time zone, and adds it to the note's attachments (`locked`: it never changes and cannot be removed; asking again issues a new one). The text is in it only if you may read it.",
      '',
      'Follow it at GET /v1/documents/{id}; your realtime connection hears `document.ready { id, subject, recordId, attachmentId }` (download it at GET /v1/attachments/{attachmentId}/download) or `document.failed { id, subject, recordId, error }`. Audited (document.requested, document.issued).',
    ].join('\n'),
  },
};
