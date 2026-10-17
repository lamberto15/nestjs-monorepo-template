import { defineFeature } from '../../../src/features/feature.js';
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
});
