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
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import { notes } from './notes.tables.js';
import { NOTE } from './note.resource.js';
import type { NoteEvent, NoteEventType } from './note-events.js';
import type { Note } from './note.schemas.js';

/** The notifications of a publication of `rows`: one `note.published` per note, to its owner and watchers. */
export function publicationNotices(
  rows: readonly Pick<Note, 'id' | 'title' | 'ownerId'>[],
  watchers: ReadonlyMap<string, readonly string[]>,
): NotifyInput[] {
  return rows.map((row) => ({
    type: 'note.published',
    to: [...new Set([row.ownerId, ...(watchers.get(row.id) ?? [])])],
    data: { noteId: row.id, title: row.title },
    link: `/notes/${row.id}`,
  }));
}

/**
 * Where a bulk publication's summary leads: the published notes, the
 * latest first.
 */
export const PUBLISHED_NOTES_LINK =
  '/notes?status=published&sort=publishedAt.desc';

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
    private readonly access: AccessService,
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
      // Past BULK_THRESHOLD notes, one summary per person of the notes they
      // may read (the catalog's `bulk: 'digest'`, #618).
      await this.notifications.notifyMany(
        tx,
        publicationNotices(after, watchers),
        {
          link: PUBLISHED_NOTES_LINK,
          readable: async (principal, inputs) => {
            const visible = await this.access.sqlFilter(
              principal,
              'Note',
              'read',
            );
            const ids = new Set(
              (
                await tx
                  .select({ id: notes.id })
                  .from(notes)
                  .where(
                    and(
                      inArray(
                        notes.id,
                        inputs.map((input) => input.data.noteId as string),
                      ),
                      visible,
                    ),
                  )
              ).map((row) => row.id),
            );
            return inputs.filter((input) =>
              ids.has(input.data.noteId as string),
            );
          },
        },
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
