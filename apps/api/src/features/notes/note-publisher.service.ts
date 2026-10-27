import { HttpException, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { Webhooks } from '@nestjs/webhooks';
import {
  NotificationsService,
  type NotifyInput,
} from '../../platform/notifications/notifications.service.js';
import { ApprovalsService } from '../../platform/approvals/approvals.service.js';
import { SubscriptionsService } from '../../platform/subscriptions/subscriptions.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import { notes } from './notes.tables.js';
import { NOTE } from './note.resource.js';
import type { NoteEvent, NoteEventType } from './note-events.js';
import type { Note } from './note.schemas.js';

/**
 * Past this many notes published at once (an import group), each person
 * gets one `note.publishedMany` instead of one `note.published` per note: a
 * 100,000-note import must not mean 100,000 notifications and mails (#618).
 */
export const BULK_PUBLICATION = 20;

/**
 * The notifications of a publication of `rows`: one `note.published` per
 * note, to its owner and watchers; past BULK_PUBLICATION, one
 * `note.publishedMany` per person, with how many of the notes are theirs
 * (owned or watched) and the first one's title.
 */
export function publicationNotices(
  rows: readonly Pick<Note, 'id' | 'title' | 'ownerId'>[],
  watchers: ReadonlyMap<string, readonly string[]>,
): NotifyInput[] {
  const recipientsOf = (row: (typeof rows)[number]) => [
    ...new Set([row.ownerId, ...(watchers.get(row.id) ?? [])]),
  ];
  if (rows.length <= BULK_PUBLICATION) {
    return rows.map((row) => ({
      type: 'note.published',
      to: recipientsOf(row),
      data: { noteId: row.id, title: row.title },
      link: `/notes/${row.id}`,
    }));
  }
  const byRecipient = new Map<string, { notes: number; title: string }>();
  for (const row of rows) {
    for (const recipient of recipientsOf(row)) {
      const seen = byRecipient.get(recipient);
      if (seen) seen.notes += 1;
      else byRecipient.set(recipient, { notes: 1, title: row.title });
    }
  }
  return [...byRecipient].map(([to, data]) => ({
    type: 'note.publishedMany',
    to,
    data,
    link: '/notes',
  }));
}

/**
 * What the publication workflow's step does, and how note webhooks are
 * dispatched. Kept apart from NotesService, which starts the workflow, so
 * the workflow and the service don't import each other. A publication
 * also notifies the owner (in-app and live, by mail or webhook as they
 * prefer: docs/notifications.md), in the same transaction.
 */
@Injectable()
export class NotePublisher {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly webhooks: Webhooks<Transaction>,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  /**
   * A draft becomes published, once: `false` when it was deleted or
   * already published. `by` is the audit's actor: the workflow that
   * publishes it (`system:note-publication`, or `system:approvals` after an
   * approval).
   */
  async publish(id: string, by: Principal): Promise<boolean> {
    const published = await inTransaction(this.txHost, async (tx) => {
      // Never a deleted note (in the recycle bin), whoever asks: an approval included.
      const [before] = await tx
        .select()
        .from(notes)
        .where(
          and(
            eq(notes.id, id),
            eq(notes.status, 'draft'),
            isNull(notes.deletedAt),
          ),
        )
        .for('update');
      if (!before) {
        return undefined;
      }
      const [row] = await tx
        .update(notes)
        .set({ status: 'published', publishedAt: new Date() })
        .where(eq(notes.id, id))
        .returning();
      await this.audit.recordChange(
        by,
        NOTE,
        { action: 'updated', id, before, after: row! },
        tx,
      );
      if (row) {
        await this.dispatch(tx, 'note.published', row);
        // The owner, and whoever watches the note.
        await this.notifications.notify(tx, {
          type: 'note.published',
          to: [
            row.ownerId,
            ...(await this.subscriptions.watchers({
              subject: 'Note',
              recordId: row.id,
            })),
          ],
          data: { noteId: row.id, title: row.title },
          link: `/notes/${row.id}`,
        });
      }
      return row;
    });
    // Deliver now instead of at the next poll.
    this.webhooks.notify();
    this.notifications.deliverNow();
    return !!published;
  }

  /** Publishes drafts as one locked read and one UPDATE; used by an import group's workflow. */
  async publishMany(ids: readonly string[], by: Principal) {
    if (!ids.length) return 0;
    const published = await inTransaction(this.txHost, async (tx) => {
      const before = await tx
        .select()
        .from(notes)
        .where(
          and(
            inArray(notes.id, [...ids]),
            eq(notes.status, 'draft'),
            isNull(notes.deletedAt),
          ),
        )
        .for('update');
      if (!before.length) return 0;
      const after = await tx
        .update(notes)
        .set({ status: 'published', publishedAt: new Date() })
        .where(
          and(
            inArray(
              notes.id,
              before.map((note) => note.id),
            ),
            eq(notes.status, 'draft'),
            isNull(notes.deletedAt),
          ),
        )
        .returning();
      const previous = new Map(before.map((note) => [note.id, note]));
      await this.audit.recordChanges(
        by,
        NOTE,
        after.map((row) => ({
          action: 'updated' as const,
          id: row.id,
          before: previous.get(row.id)!,
          after: row,
        })),
        tx,
      );
      await this.dispatchMany(tx, 'note.published', after);
      const watchers = await this.subscriptions.watchersMany(
        after.map((row) => ({ subject: 'Note', recordId: row.id })),
        tx,
      );
      await this.notifications.notifyMany(
        tx,
        publicationNotices(after, watchers),
      );
      return after.length;
    });
    this.webhooks.notify();
    this.notifications.deliverNow();
    return published;
  }

  /**
   * Asks for the approval of a publication (the publication workflow's
   * step), as the note's owner: `not-needed` when the policy says so (the
   * notes.publishApproval flag is off for them), `gone` for a note no
   * longer a draft, `refused` when approvals refuse it (nobody to approve).
   */
  async requestApproval(
    id: string,
    idempotencyKey: string,
  ): Promise<'not-needed' | 'requested' | 'gone' | 'refused'> {
    const [note] = await this.db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.id, id),
          eq(notes.status, 'draft'),
          isNull(notes.deletedAt),
        ),
      );
    if (!note) {
      return 'gone';
    }
    try {
      const result = await this.approvals.request(note.ownerId, {
        subject: 'Note',
        recordId: id,
        action: 'publish',
        // The payload is read from the note itself (NotePublishApproval.payload).
        idempotencyKey,
      });
      return result.required ? 'requested' : 'not-needed';
    } catch (error) {
      // approval_no_approvers, approval_pending: the note stays a draft.
      if (error instanceof HttpException && error.getStatus() < 500) {
        return 'refused';
      }
      throw error;
    }
  }

  /** Webhooks go to the API client that owns the note; a user's notes have none. */
  async dispatch(tx: Transaction, type: NoteEventType, note: Note) {
    const tenant = note.ownerId.startsWith('client:')
      ? note.ownerId.slice('client:'.length)
      : null;
    if (!tenant) {
      return;
    }
    const data: NoteEvent = { noteId: note.id, title: note.title };
    await this.webhooks.dispatch(tx, { type, tenant, data });
  }

  /** Dispatches webhook events for many notes with the package's array API. */
  async dispatchMany(
    tx: Transaction,
    type: NoteEventType,
    rows: readonly Note[],
  ) {
    const messages = rows.flatMap((note) => {
      const tenant = note.ownerId.startsWith('client:')
        ? note.ownerId.slice('client:'.length)
        : null;
      return tenant
        ? [{ type, tenant, data: { noteId: note.id, title: note.title } }]
        : [];
    });
    if (messages.length) await this.webhooks.dispatch(tx, messages);
  }
}
