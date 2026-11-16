import { Module } from '@nestjs/common';
import { recordParts } from '../../../src/platform/records/record-parts.js';
import { TestItemPublishApproval } from './test-item-approvals.js';
import { TEST_ITEM_APPROVALS } from './test-item.approvals.js';
import { TEST_ITEM_LIST } from './test-item.list.js';
import { TestItemPolicy } from './test-item.policy.js';
// capability:ai begin
import { TestItemAi } from './test-item-ai.js';
// capability:ai end
import { TEST_ITEM } from './test-item.record.js';
import { TEST_ITEM_SCHEMAS } from './test-item.schemas.js';
import { TestDeprecatedController } from './test-deprecated.controller.js';
import { TestItemsController } from './test-items.controller.js';
import { TestItemsService } from './test-items.service.js';
import { testItems } from './test-items.tables.js';

/** What the platform adds for its capabilities (test-item.record.ts): routes, targets, lifecycle, presenter. */
const parts = recordParts(TEST_ITEM, {
  service: TestItemsService,
  policy: TestItemPolicy,
  table: testItems,
  list: TEST_ITEM_LIST,
  schemas: TEST_ITEM_SCHEMAS,
  approvals: TEST_ITEM_APPROVALS,
});

/** Test items. */
@Module({
  controllers: [
    TestItemsController,
    TestDeprecatedController,
    ...parts.controllers,
  ],
  providers: [
    TestItemsService,
    TestItemPolicy,
    TestItemPublishApproval,
    // capability:ai begin
    TestItemAi,
    // capability:ai end
    ...parts.providers,
  ],
  exports: [TestItemsService],
})
export class TestItemsModule {}
