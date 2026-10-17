import type { z } from 'zod';
import { recordSchemas } from '../../../src/platform/records/record.schemas.js';
import { TEST_ITEM } from './test-item.record.js';
import type { testItems } from './test-items.tables.js';

/** The API's schemas of test items, from test-item.record.ts: create, update, response, bulk. */
export const TEST_ITEM_SCHEMAS = recordSchemas(TEST_ITEM);
export type CreateTestItemDto = z.infer<typeof TEST_ITEM_SCHEMAS.create>;
export type UpdateTestItemDto = z.infer<typeof TEST_ITEM_SCHEMAS.update>;

/** A test item as stored; the API shows it through RecordPresenter. */
export type TestItem = typeof testItems.$inferSelect;
