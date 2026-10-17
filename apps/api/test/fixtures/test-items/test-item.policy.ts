import { Policy } from '@nestjs/authorization';
import { defineSystemJob } from '../../../src/iam/access/permissions.js';
import {
  recordPermissions,
  RecordPolicy,
} from '../../../src/platform/records/record-policy.js';
import { TEST_ITEM } from './test-item.record.js';
import { testItems } from './test-items.tables.js';

/**
 * A system job that asks for approval on behalf of test items' owners, as
 * the approval engine's tests do outside a request
 * (`system:test-item-publication`).
 */
export const TEST_ITEM_PUBLICATION_JOB = defineSystemJob({
  key: 'test-item-publication',
  label: 'Test item publication',
  description:
    'Publishes test items, or asks for approval first, for their owners.',
  permissions: [{ subject: 'TestItem', action: 'update', conditions: [] }],
});

/**
 * What can be done with test items (the platform's tests' record: test/fixtures),
 * and the conditions an administrator may attach (GET /v1/access/catalog): the
 * standard actions, conditions and seed roles' grants, from test-item.record.ts
 * (recordPermissions: the recycle bin, teams and custom as it says). Generated
 * by `pnpm feature:add`, then a field-level permission (`body`), which the
 * platform's tests read.
 */
export const TEST_ITEM_PERMISSIONS = recordPermissions(TEST_ITEM, testItems, {
  fields: {
    body: { label: "The test item's text" },
  },
  systemJobs: [TEST_ITEM_PUBLICATION_JOB],
});

/**
 * Who may do what with a test item: each action checked against its fields (RecordPolicy).
 * Business logic: a rule of the feature's overrides an action here.
 */
@Policy()
export class TestItemPolicy extends RecordPolicy {}
