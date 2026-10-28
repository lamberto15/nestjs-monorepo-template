import { field, type Referenced } from '../../../src/platform/fields/field.js';
import {
  defineRecord,
  recordTableOf,
} from '../../../src/platform/records/record.js';
import { recordSetting } from '../../../src/platform/records/record-settings.js';

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
  unit: true,
  // Many platform tests act as an API client on test items.
  clientAccess: 'own',
  grants: 'standard',
  // Its number, gapless per tenant: TI-2026-00001 (perYear: false drops the year).
  number: { prefix: 'TI', perYear: true, width: 5 },
  // Declared as a generated feature declares them (the generator's --approvals
  // and --settings): the platform's tests cover the derived routes and keys.
  approvals: {
    archive: { label: 'Archive a test item' },
    markReviewed: { label: 'Mark a test item reviewed' },
  },
  settings: {
    archiveAfterDays: recordSetting.int(90).min(1).max(365),
    autoArchive: recordSetting.flag(),
    sortBy: recordSetting.enum(['title', 'createdAt'], 'createdAt'),
  },
  fields: {
    title: field.string().searchable(),
    body: field.text().optional().searchable(),
    // Set by publishing (test-items.service.ts, through approval when the flag is on); the API takes it as any field.
    publishedAt: field.datetime().optional(),
    code: field.string().optional().unique(),
    // A test item's parent, another test item: the platform's relationships
    // (record-relations.ts) are tested on it. A reference to its own records
    // names their table through the declaration (its tables file imports this one).
    parentId: field.ref((): Referenced => recordTableOf(TEST_ITEM)).optional(),
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
