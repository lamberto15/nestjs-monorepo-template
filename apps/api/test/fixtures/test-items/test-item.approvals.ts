import {
  recordApprovalEffects,
  type RecordApprovalApplied,
} from '../../../src/platform/records/record-approvals.js';
import { TEST_ITEM } from './test-item.record.js';
import type { TestItemsService } from './test-items.service.js';

/**
 * What approval does to a test item, as a generated feature writes it
 * (`pnpm feature:add --approvals archive`): archiving marks its body.
 */
export const TEST_ITEM_APPROVALS = recordApprovalEffects(TEST_ITEM, {
  archive: {
    /** Idempotent: a second run finds the body already marked. */
    async apply({
      id,
      actor,
      service,
    }: RecordApprovalApplied<TestItemsService>) {
      const row = await service.findOne(id);
      if (row.body !== 'archived') {
        await service.update(actor, row, { body: 'archived' });
      }
    },
  },
});
