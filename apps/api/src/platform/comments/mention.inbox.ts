import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { tenantPredicate } from '../../core/tenancy/tenant-query.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import {
  type InboxEntry,
  InboxRegistry,
  type InboxSource,
} from '../inbox/inbox.registry.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { notifications } from '../notifications/notifications.tables.js';
import { SubscriptionsRegistry } from '../subscriptions/subscriptions.registry.js';

/** Candidate rows read at a time while some are filtered out, and the most rounds. */
const ROUND = 50;
const ROUNDS = 5;

/**
 * The inbox's mentions: the user's unread `comment.mentioned` notifications
 * (the notification is the record of the mention; reading it completes the
 * item, so the bell and the inbox agree). A mention on a record the person
 * can no longer read (access changed, deleted) is left out, checked now as
 * watching it would be, so its title and excerpt are never shown. Dismissed
 * by marking the notification read.
 */
@Injectable()
export class MentionInboxSource implements InboxSource {
  readonly name = 'mention';

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly targets: SubscriptionsRegistry,
    private readonly notifications: NotificationsService,
    inbox: InboxRegistry,
  ) {
    inbox.register(this);
  }

  async items(
    principal: Principal,
    page: { limit: number; after?: string },
  ): Promise<InboxEntry[]> {
    const entries: InboxEntry[] = [];
    let after = page.after;
    for (
      let round = 0;
      round < ROUNDS && entries.length < page.limit;
      round++
    ) {
      const rows = await this.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.recipient, principalKey(principal)),
            eq(notifications.type, 'comment.mentioned'),
            isNull(notifications.readAt),
            // An account's own rows (no tenant) are never mentions; an administrator
            // acting as the person sees the tenant's only, as the bell does.
            tenantPredicate(notifications.tenantId),
            after ? lt(notifications.id, after) : undefined,
          ),
        )
        .orderBy(desc(notifications.id))
        .limit(ROUND);
      for (const row of rows) {
        const data = row.data as {
          subject?: string;
          recordId?: string;
          commentId?: string;
          title?: string;
          by?: string;
          excerpt?: string;
        };
        if (entries.length < page.limit && (await this.sees(principal, data))) {
          entries.push({
            id: row.id,
            at: row.createdAt,
            kind: 'mention',
            data: { title: data.title, by: data.by, excerpt: data.excerpt },
            link: row.link,
            dueAt: null,
            subject: data.subject,
            recordId: data.recordId,
            dedupe: `mention:${data.commentId ?? row.id}`,
          });
        }
        after = row.id;
        if (entries.length >= page.limit) {
          break;
        }
      }
      if (rows.length < ROUND) {
        break;
      }
    }
    return entries;
  }

  async dismiss(principal: Principal, id: string) {
    await this.notifications.markRead(principal, id);
  }

  private async sees(
    principal: Principal,
    data: { subject?: string; recordId?: string },
  ) {
    const target = data.subject ? this.targets.find(data.subject) : undefined;
    if (!target || !data.recordId) {
      return false;
    }
    try {
      await target.assertCanWatch(principal, data.recordId);
      return true;
    } catch {
      return false;
    }
  }
}
