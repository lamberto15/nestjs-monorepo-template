import { defineFeature } from '../../../src/features/feature.js';
import { TEST_ITEM_PUBLISH_APPROVAL } from './test-item-approvals.js';
import { TEST_ITEM_SETTINGS } from './test-item-settings.js';
import { TEST_ITEM_PERMISSIONS } from './test-item.policy.js';
import { TEST_ITEM } from './test-item.record.js';
import { TEST_ITEM_RESOURCE } from './test-item.resource.js';
import { TestItemsModule } from './test-items.module.js';

/** Test items, as the groups take them (features/index.ts). */
export const TEST_ITEMS_FEATURE = defineFeature({
  module: TestItemsModule,
  apiTag: {
    name: 'test-items',
    description: 'Test-only record (apps/api/test/fixtures)',
  },
  permissions: TEST_ITEM_PERMISSIONS,
  resources: [TEST_ITEM_RESOURCE],
  record: TEST_ITEM,
  // What the platform's tests work on: settings and flags, an action that needs approval.
  settings: TEST_ITEM_SETTINGS,
  approvals: [TEST_ITEM_PUBLISH_APPROVAL],
});
