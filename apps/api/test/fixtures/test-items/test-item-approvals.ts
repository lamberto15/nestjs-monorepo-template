import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ApprovalsRegistry } from '../../../src/platform/approvals/approvals.registry.js';
import {
  type ApprovalHandler,
  type ApprovalOutcome,
  defineApproval,
} from '../../../src/platform/approvals/approval.types.js';
import { recordView } from '../../../src/platform/records/record.js';
import { TEST_ITEM } from './test-item.record.js';
import { TEST_ITEM_PUBLISH_APPROVAL_FLAG } from './test-item-settings.js';
import { TestItemsService } from './test-items.service.js';

/** What a publication request carries: the title the approvers see. */
const payload = z.object({ title: z.string().max(200) });
type Payload = z.infer<typeof payload>;

/**
 * Publishing a test item can need approval (docs/approvals.md), declared as
 * a real feature does (notes' note-approvals.ts), so the approval engine's
 * tests have an action of their own whatever features a project keeps:
 * with testItems.publishApproval on, an editor but the owner decides.
 */
export const TEST_ITEM_PUBLISH_APPROVAL = defineApproval({
  subject: 'TestItem',
  action: 'publish',
  label: 'Publish a test item',
  description: 'An editor approves a test item before it is published.',
  payload,
  setting: TEST_ITEM_PUBLISH_APPROVAL_FLAG,
  policy: {
    stages: [
      {
        name: 'Editor review',
        approvers: [{ type: 'role', role: 'editor' }],
        mode: { type: 'any' },
      },
    ],
  },
});

/** What approval does to a test item: sets `publishedAt`, once (the handlers run at least once). */
@Injectable()
export class TestItemPublishApproval implements ApprovalHandler<Payload> {
  readonly approval = TEST_ITEM_PUBLISH_APPROVAL;

  constructor(
    registry: ApprovalsRegistry,
    private readonly testItems: TestItemsService,
  ) {
    registry.handle(this);
  }

  /** For the `permission` rule and conditions: the item (a 404 when gone counts as none). */
  record(id: string) {
    return this.testItems.findOne(id);
  }

  async describe(id: string, { title }: Payload) {
    return { title, link: `/test-items/${id}` };
  }

  /** What is approved is the item as it is (never what a caller says it is). */
  async payload(id: string): Promise<Payload> {
    return { title: (await this.testItems.findOne(id)).title };
  }

  /** The item's content, hashed: an edit that went around the lock isn't published as approved. */
  async fingerprint(id: string) {
    try {
      const item = await this.testItems.findOne(id);
      return createHash('sha256')
        .update(JSON.stringify(recordView(TEST_ITEM, item)))
        .digest('base64url');
    } catch (error) {
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
  }

  /** As the approvals workflow (`actor`, `system:approvals`): the audit's actor. */
  async onApproved({ request, actor }: ApprovalOutcome<Payload>) {
    await this.testItems.publish(request.recordId, actor);
  }
}
