import { recordList } from '../../../src/platform/records/record-list.js';
import { TEST_ITEM } from './test-item.record.js';
import { TEST_ITEM_SCHEMAS } from './test-item.schemas.js';
import { testItems } from './test-items.tables.js';

/** What GET /test-items can be filtered, sorted and narrowed by: derived from test-item.record.ts. */
export const TEST_ITEM_LIST = recordList(
  TEST_ITEM,
  testItems as never,
  TEST_ITEM_SCHEMAS,
);
