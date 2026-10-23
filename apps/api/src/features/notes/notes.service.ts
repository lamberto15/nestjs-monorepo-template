import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { IncomingWebhook } from '@nestjs/webhooks';
import { Webhooks } from '@nestjs/webhooks';
import { WorkflowClient } from '@nestjs/workflows';
import {
  and,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  SQL,
  inArray,
  sql,
} from 'drizzle-orm';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
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
import { NamingSeriesService } from '../../platform/sequences/naming-series.service.js';
import { SubscriptionsService } from '../../platform/subscriptions/subscriptions.service.js';
import { TagsService } from '../../platform/tags/tags.service.js';
import { IncomingEventHandlers } from '../../platform/webhooks/incoming-event-handlers.js';
import { RevisionsService } from '../../platform/revisions/revisions.service.js';
import { ApprovalsService } from '../../platform/approvals/approvals.service.js';
import { TeamsService } from '../../iam/access/teams.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { LegalHoldsService } from '../../iam/holds/legal-holds.service.js';
import { RetentionRegistry } from '../../platform/retention/retention.registry.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import type { Database, Transaction } from '../../core/database/drizzle.js';
import { notes } from './notes.tables.js';
import { NOTE_PUBLICATION_JOB } from './note.policy.js';
import { publishNow } from './note-events.js';
import {
  NoteBatchPublicationWorkflow,
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
    private readonly namingSeries: NamingSeriesService,
    private readonly tags: TagsService,
    private readonly revisions: RevisionsService,
    private readonly approvals: ApprovalsService,
    private readonly tenancy: Tenancy,
    private readonly holds: LegalHoldsService,
    private readonly system: SystemContext,
    private readonly quotas: TenantQuotas,
    incomingEvents: IncomingEventHandlers,
    retention: RetentionRegistry,
  ) {
    // The tenant's limit on notes (docs/tenancy.md, "Quotas"); the recycle bin is not counted.
    quotas.count('records:Note', async (db) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(notes)
        .where(isNull(notes.deletedAt));
      return row?.n ?? 0;
    });
    // Notes are purged after the days a tenant sets (off until it turns the rule on).
    retention.register({
      name: 'note',
      label: 'Notes',
      subject: 'Note',
      table: notes,
      ageColumn: notes.createdAt,
      action: 'purge',
      defaultDays: 730,
      minDays: 30,
    });
    // Numbered NOTE-2026-00042 until the tenant defines naming series of its own.
    namingSeries.register({
      subject: 'Note',
      sequence: 'note',
      declared: { prefix: 'NOTE', perYear: true, width: 5 },
      // What a series may print or test: NOTE-.{title}.-.### counts per title.
      fields: { title: 'text' },
    });
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
      // 422 `quota_exceeded` at the tenant's limit of notes, under its lock.
      await this.quotas.assertRoom(tx, this.tenancy.tenantId(), 'records:Note');
      // Its number: gapless, in this transaction, from the naming series the
      // body names, else the first whose conditions hold for it, else the
      // default (NOTE-2026-00042 without any).
      const { formatted: number } = await this.namingSeries.next(tx, 'Note', {
        seriesId: dto.namingSeriesId,
        values: { title: dto.title },
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

  /** Creates one import group under one transaction and grouped side effects. */
  async createMany(
    owner: Principal,
    dtos: readonly CreateNoteDto[],
    { by = owner }: { by?: Principal } = {},
  ): Promise<Note[]> {
    if (!dtos.length) return [];
    const customs = await Promise.all(
      dtos.map((dto) =>
        this.customFields.parseValues('Note', dto.custom, 'create'),
      ),
    );
    const rows = await inTransaction(this.txHost, async (tx) => {
      await this.quotas.assertRoom(
        tx,
        this.tenancy.tenantId(),
        'records:Note',
        dtos.length,
      );
      const numbers = await this.namingSeries.nextMany(
        tx,
        'Note',
        dtos.map((dto) => ({
          seriesId: dto.namingSeriesId,
          values: { title: dto.title },
        })),
      );
      const teamId =
        owner.kind === 'user'
          ? ((await this.teams.teamsOf(owner.id, tx))[0] ?? null)
          : null;
      const created = await tx
        .insert(notes)
        .values(
          dtos.map((dto, index) => ({
            number: numbers[index]!.formatted,
            ownerId: principalKey(owner),
            teamId,
            title: dto.title,
            body: dto.body,
            custom: customs[index]!,
            status: 'draft' as const,
          })),
        )
        .returning();
      const tenantId = created[0]!.tenantId;
      await this.workflowClient.start(
        NoteBatchPublicationWorkflow,
        { noteIds: created.map((note) => note.id), tenantId },
        { id: `note-batch-${randomUUID()}`, transaction: tx },
      );
      await this.publisher.dispatchMany(tx, 'note.created', created);
      await this.subscriptions.subscribeMany(
        tx,
        owner,
        created.map((note) => ({ subject: 'Note', recordId: note.id })),
      );
      await this.audit.recordChanges(
        by,
        NOTE,
        created.map((note) => ({
          action: 'created' as const,
          id: note.id,
          after: note,
        })),
        tx,
      );
      await this.revisions.recordMany(
        tx,
        'Note',
        created.map((note) => ({
          recordId: note.id,
          snapshot: noteSnapshot(note),
          by,
        })),
      );
      return created;
    });
    this.webhooks.notify();
    return rows;
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

  /** Applies a group of edits with one row lock query and one UPDATE FROM VALUES. */
  async updateMany(
    by: Principal,
    matches: readonly { noteId: string; dto: UpdateNoteDto }[],
    ip?: string,
  ) {
    if (!matches.length) return [];
    const patches = await Promise.all(
      matches.map(({ dto }) =>
        this.customFields.parseValues('Note', dto.custom, 'update'),
      ),
    );
    const updated = await inTransaction(this.txHost, async (tx) => {
      const locked = await tx
        .select()
        .from(notes)
        .where(
          and(
            inArray(
              notes.id,
              matches.map((item) => item.noteId),
            ),
            isNull(notes.deletedAt),
          ),
        )
        .for('update');
      const beforeById = new Map(locked.map((note) => [note.id, note]));
      if (locked.length !== matches.length)
        throw new NotFoundException('A matched note no longer exists.');
      const changes = matches
        .map((item, index) => {
          const before = beforeById.get(item.noteId)!;
          const { custom: _custom, ...dto } = item.dto;
          const custom = { ...before.custom };
          for (const [key, value] of Object.entries(patches[index]!)) {
            if (value === null) delete custom[key];
            else custom[key] = value;
          }
          const setTitle =
            dto.title !== undefined && dto.title !== before.title;
          const setBody = dto.body !== undefined && dto.body !== before.body;
          const setCustom =
            JSON.stringify(custom) !== JSON.stringify(before.custom);
          return {
            id: item.noteId,
            before,
            title: dto.title ?? before.title,
            setTitle,
            body: dto.body ?? before.body,
            setBody,
            custom,
            setCustom,
          };
        })
        .filter((item) => item.setTitle || item.setBody || item.setCustom);
      if (!changes.length) return [];
      await this.approvals.assertNotPendingMany(
        'Note',
        changes.map((item) => item.id),
      );
      const values = sql.join(
        changes.map(
          (item) => sql`(
        ${item.id}::uuid, ${item.title}::text, ${item.setTitle}::boolean,
        ${item.body}::text, ${item.setBody}::boolean,
        ${JSON.stringify(item.custom)}::jsonb, ${item.setCustom}::boolean
      )`,
        ),
        sql`, `,
      );
      // PostgreSQL's single set-based UPDATE avoids one UPDATE and commit path per imported note.
      await tx.execute(sql`update notes set
        title = case when batch.set_title then batch.title else notes.title end,
        body = case when batch.set_body then batch.body else notes.body end,
        custom = case when batch.set_custom then batch.custom else notes.custom end,
        updated_at = now()
      from (values ${values}) as batch(id, title, set_title, body, set_body, custom, set_custom)
      where notes.id = batch.id`);
      const after = await tx
        .select()
        .from(notes)
        .where(
          inArray(
            notes.id,
            changes.map((item) => item.id),
          ),
        );
      const beforeByUpdated = new Map(
        changes.map((item) => [item.id, item.before]),
      );
      await this.subscriptions.notifyWatchersMany(
        tx,
        after.map((row) => ({
          subject: 'Note',
          recordId: row.id,
          type: 'note.changed',
          data: { noteId: row.id, title: row.title, by: by.name },
          key: `note.changed:${row.id}`,
          link: `/notes/${row.id}`,
          except: by,
        })),
      );
      await this.audit.recordChanges(
        by,
        NOTE,
        after.map((row) => ({
          action: 'updated' as const,
          id: row.id,
          before: beforeByUpdated.get(row.id)!,
          after: row,
        })),
        tx,
        ip,
      );
      await this.revisions.recordMany(
        tx,
        'Note',
        after.map((row) => ({
          recordId: row.id,
          snapshot: noteSnapshot(row),
          before: noteSnapshot(beforeByUpdated.get(row.id)!),
          by,
        })),
      );
      return after;
    });
    this.notifications.deliverNow();
    return updated;
  }

  /** To the recycle bin (soft delete): hidden everywhere, restorable until purged. */
  async delete(by: Principal, note: Note, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      // Not under a legal hold (a 409 legal_hold).
      await this.holds.assertNotHeld('Note', [note.id], tx);
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
    let offset = 0;
    for (;;) {
      const instances = await this.workflowClient.list({
        workflow: 'note-batch-publication',
        status: ['pending', 'running', 'suspended'],
        limit: 100,
        offset,
      });
      const batch = instances.find((instance) => {
        const input = instance.input as { noteIds?: unknown };
        return Array.isArray(input.noteIds) && input.noteIds.includes(noteId);
      });
      if (batch) {
        // A grouped workflow has no individual publication wait; publish this requested note directly, and let the group's later UPDATE skip it.
        await this.system.run(
          NOTE_PUBLICATION_JOB,
          (system) => this.publisher.publish(noteId, system),
          { transaction: false },
        );
        return;
      }
      if (instances.length < 100) break;
      offset += instances.length;
    }
    await this.workflowClient.signal(
      publishNow,
      { eventId, tenantId: note.tenantId },
      { key: noteId, transaction: tx },
    );
  }
}
