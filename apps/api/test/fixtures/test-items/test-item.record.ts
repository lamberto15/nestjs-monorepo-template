import { field } from '../../../src/platform/fields/field.js';
import { defineRecord } from '../../../src/platform/records/record.js';

/**
 * Test items: their fields and capabilities, declared once. The table,
 * schemas, list, capability routes and targets are derived from it
 * (platform/records). Add a field or a capability here, then
 * `pnpm feature:sync` and `pnpm db:generate` (docs/adding-a-feature.md).
 */
export const TEST_ITEM = defineRecord({
  subject: 'TestItem',
  path: 'test-items',
  apiTag: 'test-items',
  className: 'TestItem',
  noun: 'test item',
  table: 'test_items',
  softDelete: true,
  team: true,
  // Many platform tests act as an API client on test items.
  clientAccess: 'own',
  grants: 'standard',
  // Its number, gapless per tenant: TI-2026-00001 (perYear: false drops the year).
  number: { prefix: 'TI', perYear: true, width: 5 },
  fields: {
    title: field.string().searchable(),
    body: field.text().optional().searchable(),
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
    'events',
    'numbered',
  ],
});
