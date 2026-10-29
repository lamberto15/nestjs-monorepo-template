import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import {
  type InboxEntry,
  InboxRegistry,
  type InboxSource,
} from '../inbox/inbox.registry.js';
import { assignedTo } from './approval.list.js';
import { approvalRequests } from './approvals.tables.js';

const r = approvalRequests;

/**
 * The inbox's approvals: requests waiting on the user's decision now (their
 * own assignment, or of someone they stand in for: `assignedTo`), and their
 * own requests the approvers sent back for changes. Read from the requests
 * themselves, so an item is gone the moment it is decided, cancelled or
 * resubmitted. Being an approver is the permission: nothing else to filter.
 * Completed by deciding or resubmitting, not dismissed.
 */
@Injectable()
export class ApprovalInboxSource implements InboxSource {
  readonly name = 'approval';

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    inbox: InboxRegistry,
  ) {
    inbox.register(this);
  }

  async items(
    principal: Principal,
    page: { limit: number; after?: string },
  ): Promise<InboxEntry[]> {
    if (principal.kind !== 'user') {
      return [];
    }
    const rows = await this.db
      .select()
      .from(r)
      .where(
        and(
          or(
            assignedTo(principal.id),
            and(
              eq(r.status, 'changes_requested'),
              eq(r.requester, principalKey(principal)),
            ),
          ),
          page.after ? lt(r.id, page.after) : undefined,
        ),
      )
      .orderBy(desc(r.id))
      .limit(page.limit);
    return rows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      kind: row.status === 'pending' ? 'approval.decide' : 'approval.revise',
      data: {
        action: row.action,
        title: row.title,
        requester: row.requesterName,
      },
      link: `/approvals/${row.id}`,
      dueAt: row.status === 'pending' ? row.dueAt : null,
      subject: row.subject,
      recordId: row.recordId,
      dedupe: `approval:${row.id}`,
    }));
  }
}
