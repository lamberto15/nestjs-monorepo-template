import { z } from 'zod';
import {
  defineSettings,
  flag,
  setting,
} from '../../../src/platform/settings/setting.types.js';

/**
 * Test items' settings and flags, declared as a real feature does (notes'
 * note-settings.ts), so the platform's tests have every kind of key to work
 * on, whatever features a project keeps: a flag with all scopes (rollouts),
 * a value with team and user scopes (a preference), a tenant-only value
 * for managers, and the flag that switches the publication's approval on.
 */

/** Whether the web app offers the rich preview: on for the tenant, a team, one principal, or a rollout. */
export const TEST_ITEM_RICH_PREVIEW = flag({
  key: 'testItems.richPreview',
  label: 'Rich preview',
  description: 'Lets the web app offer the rich preview of test items.',
  default: false,
});

/** How the web app lists test items: a preference a user may set for themselves, or a team for its users. */
export const TEST_ITEM_VIEW = setting({
  key: 'testItems.view',
  label: 'List view',
  description: 'How test items are listed: a table or cards.',
  schema: z.enum(['table', 'cards']),
  default: 'table',
  scopes: ['tenant', 'team', 'user'],
});

/** A tenant-wide value shown to managers only. */
export const TEST_ITEM_PAGE_LIMIT = setting({
  key: 'testItems.pageLimit',
  label: 'Page limit',
  description: 'The most test items the web app shows on a page.',
  schema: z.number().int().min(1).max(100),
  default: 25,
  public: false,
});

/** Whether publishing a test item needs approval (test-item-approvals.ts): off by default. */
export const TEST_ITEM_PUBLISH_APPROVAL_FLAG = flag({
  // Never per user: a requester could switch their own approval off
  // (ApprovalsRegistry refuses such a setting at startup).
  scopes: ['tenant', 'team'],
  key: 'testItems.publishApproval',
  label: 'Publishing needs approval',
  description:
    'When on, a test item is published only once an editor approved it (GET /v1/approvals).',
  default: false,
});

/** The test-only feature's settings and flags (test-items.feature.ts). */
export const TEST_ITEM_SETTINGS = defineSettings([
  TEST_ITEM_RICH_PREVIEW,
  TEST_ITEM_VIEW,
  TEST_ITEM_PAGE_LIMIT,
  TEST_ITEM_PUBLISH_APPROVAL_FLAG,
]);
