import { recordResource } from '../../../src/platform/records/record-resource.js';
import { TEST_ITEM } from './test-item.record.js';
import { testItems } from './test-items.tables.js';

/**
 * Test items: every change audited (testItem.created, testItem.updated…),
 * a custom value's change as `custom.<key>`, deleted ones in a recycle bin when
 * test-item.record.ts says softDelete (recordResource).
 */
export const TEST_ITEM_RESOURCE = recordResource(TEST_ITEM, testItems);
