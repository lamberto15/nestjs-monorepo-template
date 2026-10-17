import { defineResource } from '../../../src/iam/resources/resource.js';
import { testItems } from './test-items.tables.js';

/** Test items: every change audited (testItem.created, testItem.updated…); deleted ones go to a recycle bin. */
export const TEST_ITEM_RESOURCE = defineResource({
  subject: 'TestItem',
  // The search vector follows the text: not a change of its own; a custom value's change
  // (custom) is audited as `custom.<key>`.
  audit: { expand: ['custom'], ignore: ['search'] },
  softDelete: { table: testItems },
});
