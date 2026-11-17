import { field } from '../../platform/fields/field.js';
import { defineRecord } from '../../platform/records/record.js';

/**
 * Notes: their fields and capabilities, declared once. The table, schemas,
 * list, permissions, capability routes and targets are derived from it
 * (platform/records). Add a field, a capability, an approval or a setting, or flip softDelete,
 * unit, clientAccess, grants or idempotency,
 * here, then `pnpm feature:sync` and `pnpm db:generate` (docs/adding-a-feature.md).
 */
export const NOTE = defineRecord({
  subject: 'Note',
  path: 'notes',
  apiTag: 'notes',
  className: 'Note',
  noun: 'note',
  table: 'notes',
  softDelete: true,
  unit: true,
  clientAccess: false,
  grants: 'none',
  // Its number, gapless per tenant: NOTE-2026-00042 (perYear: false drops the year).
  number: { prefix: 'NOTE', perYear: true, width: 5 },
  // capability:data-quality begin
  // Its data-quality checks (platform/data-quality): an empty text is a suggestion, a title another note has too a duplicate candidate.
  quality: { recommended: ['body'], duplicates: ['title'] },
  // capability:data-quality end
  fields: {
    title: field.string().searchable(),
    body: field.text().searchable(),
    // Set by the publication workflow, never by a body.
    status: field.enum(['draft', 'published']).readOnly(),
    publishedAt: field.datetime().optional().readOnly(),
  },
  // The views besides the table (GET /v1/lists/Note `views`): a board by status and a calendar and timeline by the dates. Read-only: a note's status and dates are not changed by `PATCH` (publishing does).
  views: {
    board: { field: 'status', readOnly: true },
    calendar: { fields: ['createdAt', 'publishedAt'], readOnly: true },
    timeline: { start: 'createdAt', end: 'publishedAt' },
  },
  capabilities: [
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
    'numbered',
    // capability:shares begin
    'share',
    // capability:shares end
    // capability:automations begin
    'automation',
    // capability:automations end
    'merge',
  ],
});
