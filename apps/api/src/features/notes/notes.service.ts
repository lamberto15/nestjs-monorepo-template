import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { IncomingWebhook } from '@nestjs/webhooks';
import { Webhooks } from '@nestjs/webhooks';
import { WorkflowClient } from '@nestjs/workflows';
import { and, eq, getTableColumns, isNotNull, isNull, SQL } from 'drizzle-orm';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  type PageQuery,
  toPage,
} from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { CustomFieldsService } from '../../platform/custom-fields/custom-fields.service.js';
import { NotificationsService } from '../../platform/notifications/notifications.service.js';
import { SequencesService } from '../../platform/sequences/sequences.service.js';
import { SubscriptionsService } from '../../platform/subscriptions/subscriptions.service.js';
import { TagsService } from '../../platform/tags/tags.service.js';
import { IncomingEventHandlers } from '../../platform/webhooks/incoming-event-handlers.js';
import { RevisionsService } from '../../platform/revisions/revisions.service.js';
import { ApprovalsService } from '../../platform/approvals/approvals.service.js';
import { TeamsService } from '../../iam/access/teams.service.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { notes } from './notes.tables.js';
import { publishNow } from './note-events.js';
import {
  NotePublicationWorkflow,
  publicationId,
} from './note-publication.workflow.js';
import { NotePublisher } from './note-publisher.service.js';
import type { CreateNoteDto, Note, UpdateNoteDto } from './note.schemas.js';
import { NOTE, noteSnapshot } from './note.resource.js';

/**
 * The example feature's writes. Each change, its workflow, its webhook
 * (through the outbox) and its audit entry commit in one transaction: all
 * of them happen, or none.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly workflowClient: WorkflowClient,
    private readonly webhooks: Webhooks<Transaction>,
    private readonly publisher: NotePublisher,
    private readonly customFields: CustomFieldsService,
    private readonly audit: AuditService,
    private readonly teams: TeamsService,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly sequences: SequencesService,
    private readonly tags: TagsService,
    private readonly revisions: RevisionsService,
    private readonly approvals: ApprovalsService,
    private readonly tenancy: Tenancy,
    incomingEvents: IncomingEventHandlers,
  ) {
    // A tenant's own sender (docs/webhooks-and-realtime.md): the tenant is the
    // sender's, so the event names only the note, and the request already runs in it.
    incomingEvents.register('note.publish-requested', ({ webhook }) => {
      const data = webhook.payload.data as { noteId?: unknown } | null;
      const noteId = data?.noteId;
      if (typeof noteId !== 'string') {
        throw new BadRequestException('data.noteId is required.');
      }
      return inTransaction(this.txHost, async (tx) =>
        webhook.processInTransaction(tx, () =>
          this.requestPublish(tx, noteId, webhook.id),
        ),
      );
    });
  }

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  /** The notes with their tags (`tags: [{ id, name, color }]`): one query for them all. */
  async withTags<T extends { id: string }>(rows: T[]) {
    const tags = await this.tags.tagsOf(
      'Note',
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({ ...row, tags: tags.get(row.id) ?? [] }));
  }

  /**
   * A new draft of `owner`'s. `by` is who acts, when not the owner: the
   * demo seed (src/demo) writes its users' notes as the system principal,
   * so the audit entry and the first revision name it, and the note is
   * still theirs.
   */
  async create(
    owner: Principal,
    dto: CreateNoteDto,
    { by = owner }: { by?: Principal } = {},
  ): Promise<Note> {
    // Before the transaction: a validation error then costs no transaction.
    const custom = await this.customFields.parseValues(
      'Note',
      dto.custom,
      'create',
    );
    const note = await inTransaction(this.txHost, async (tx) => {
      // Its number: gapless, per year (NOTE-2026-00042), in this transaction.
      const { formatted: number } = await this.sequences.next(tx, 'note', {
        prefix: 'NOTE',
        perYear: true,
        width: 5,
      });
      const [row] = await tx
        .insert(notes)
        .values({
          number,
          ownerId: principalKey(owner),
          // A user's note belongs to their (first) team.
          teamId:
            owner.kind === 'user'
              ? ((await this.teams.teamsOf(owner.id, tx))[0] ?? null)
              : null,
          title: dto.title,
          body: dto.body,
          custom,
          status: 'draft',
        })
        .returning();
      // Same transaction: the publication and the note.created webhook
      // exist if and only if the note does.
      await this.workflowClient.start(
        NotePublicationWorkflow,
        { noteId: row.id, tenantId: row.tenantId },
        { id: publicationId(row.id), transaction: tx },
      );
      await this.publisher.dispatch(tx, 'note.created', row);
      // The owner watches their note: told of changes others make to it.
      await this.subscriptions.subscribe(owner, {
        subject: 'Note',
        recordId: row.id,
      });
      await this.audit.recordChange(
        by,
        NOTE,
        { action: 'created', id: row.id, after: row },
        tx,
      );
      // Revision 1: the first state, restorable like any later one.
      await this.revisions.record(tx, 'Note', row.id, {
        snapshot: noteSnapshot(row),
        by,
      });
      return row;
    });
    this.webhooks.notify(); // deliver now instead of at the next poll
    return note;
  }

  /** One note, or a 404 (deleted ones too with `deleted`: the recycle bin). */
  async findOne(
    id: string,
    db: Database | Transaction = this.db,
    /** Deleted notes too (the recycle bin): only to restore one. */
    { deleted = false }: { deleted?: boolean } = {},
  ): Promise<Note> {
    const [note] = await db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.id, id),
          deleted ? isNotNull(notes.deletedAt) : isNull(notes.deletedAt),
        ),
      );
    if (!note) {
      throw new NotFoundException(`Note ${id} not found.`);
    }
    return note;
  }

  /** A page of the notes matching `where` (the caller's read filter, from AccessService), newest first. */
  async findPage(
    where: SQL | undefined,
    query: PageQuery,
    /** Sort values that aren't columns (custom fields), for the cursor: list.sortSelect(query). */
    extra: Record<string, SQL.Aliased> = {},
  ) {
    const [rows, total] = await Promise.all([
      this.db
        .select({ ...getTableColumns(notes), ...extra })
        .from(notes)
        .where(and(where, afterCursor(notes.id, query)))
        .orderBy(...pageOrder(notes.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, notes, where, query),
    ]);
    return toPage(rows, query, total);
  }

  /** Runs a read of your own on the notes' database (exports, reports). */
  query<T>(read: (db: Database) => Promise<T>) {
    return read(this.db);
  }

  /** Changes a note; the audit entry holds what changed, from → to. */
  async update(
    by: Principal,
    note: Note,
    dto: UpdateNoteDto,
    ip?: string,
    /** Set when a revision is restored (NoteRevisions): marks the new revision. */
    { restoredFrom }: { restoredFrom?: number } = {},
  ) {
    const { custom, ...changes } = dto;
    // Only the keys sent change (jsonb ||); null removes one.
    const patch = await this.customFields.parseValues('Note', custom, 'update');
    const values = {
      ...changes,
      ...(Object.keys(patch).length > 0 && {
        custom: this.customFields.mergeValues(notes.custom, patch),
      }),
    };
    if (Object.keys(values).length === 0) {
      return note; // nothing to change
    }
    const updated = await inTransaction(this.txHost, async (tx) => {
      // Not while an approver decides on it (409 approval_pending): sent back for changes, it may change.
      await this.approvals.assertNotPending('Note', note.id);
      const [row] = await tx
        .update(notes)
        .set(values)
        .where(eq(notes.id, note.id))
        .returning();
      // Whoever watches the note hears of it, but the one who changed it;
      // repeated changes collapse into one notification per note.
      await this.subscriptions.notifyWatchers(tx, {
        subject: 'Note',
        recordId: note.id,
        type: 'note.changed',
        data: { noteId: note.id, title: row!.title, by: by.name },
        key: `note.changed:${note.id}`,
        link: `/notes/${note.id}`,
        except: by,
      });
      await this.audit.recordChange(
        by,
        NOTE,
        { action: 'updated', id: note.id, before: note, after: row },
        tx,
        ip,
      );
      await this.revisions.record(tx, 'Note', note.id, {
        snapshot: noteSnapshot(row!),
        // A note from before revisions were kept gets its first state as revision 1.
        before: noteSnapshot(note),
        by,
        restoredFrom,
      });
      return row!;
    });
    this.notifications.deliverNow();
    return updated;
  }

  /** To the recycle bin (soft delete): hidden everywhere, restorable until purged. */
  async delete(by: Principal, note: Note, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      // Not while an approver decides on it; a request sent back for changes is withdrawn with the note.
      await this.approvals.assertNotPending('Note', note.id);
      await this.approvals.withdraw(tx, by, 'Note', note.id);
      await tx
        .update(notes)
        .set({ deletedAt: new Date(), deletedBy: principalKey(by) })
        .where(eq(notes.id, note.id));
      await this.publisher.dispatch(tx, 'note.deleted', note);
      if (note.ownerId !== principalKey(by)) {
        // Someone else's doing: the owner is told (and can't switch it off).
        await this.notifications.notify(tx, {
          type: 'note.deleted',
          to: note.ownerId,
          data: { noteId: note.id, title: note.title, by: by.name },
        });
      }
      await this.audit.recordChange(
        by,
        NOTE,
        { action: 'deleted', id: note.id, before: note },
        tx,
        ip,
      );
    });
    // A draft's publication would find nothing to publish: stop it.
    await this.workflowClient.cancel(publicationId(note.id), 'Note deleted.');
    this.webhooks.notify();
    this.notifications.deliverNow();
  }

  /** Out of the recycle bin. A draft's publication was cancelled on delete: publish it again by hand. */
  async restore(by: Principal, note: Note, ip?: string) {
    return inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .update(notes)
        .set({ deletedAt: null, deletedBy: null })
        .where(eq(notes.id, note.id))
        .returning();
      await this.audit.recordChange(
        by,
        NOTE,
        { action: 'restored', id: note.id, after: row },
        tx,
        ip,
      );
      return row;
    });
  }

  /** The example sender asked to publish now: a signal to the note's workflow, in the webhook's transaction. */
  /**
   * An incoming webhook asks for a publication: recorded with the event, in
   * one transaction, so a redelivered event changes nothing (`duplicate`).
   * The route is public (the sender signs it), so it has no tenant: the
   * event names the note's tenant, and the transaction runs in it (an
   * unknown tenant, or a note of another, is a 404 like an unknown note).
   */
  publishFromWebhook(
    webhook: IncomingWebhook<{ data: { noteId: string; tenantId: string } }>,
  ) {
    const { noteId, tenantId } = webhook.payload.data;
    return this.tenancy.run(tenantId.toLowerCase(), () =>
      inTransaction(this.txHost, async (tx) =>
        webhook.processInTransaction(tx, () =>
          this.requestPublish(tx, noteId, webhook.id),
        ),
      ),
    );
  }

  async requestPublish(tx: Transaction, noteId: string, eventId: string) {
    const note = await this.findOne(noteId, tx); // 404 before anything is recorded
    await this.workflowClient.signal(
      publishNow,
      { eventId, tenantId: note.tenantId },
      { key: noteId, transaction: tx },
    );
  }
}
