import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Webhooks } from '@nestjs/webhooks';
import { WorkflowClient } from '@nestjs/workflows';
import { and, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { TenantQuotas } from '../../core/tenancy/tenant-quotas.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { OrganizationalUnitsService } from '../../iam/organization/organizational-units.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { principalKey, type Principal } from '../../iam/auth/principal.js';
import { ApprovalsService } from '../../platform/approvals/approvals.service.js';
import { CustomFieldsService } from '../../platform/custom-fields/custom-fields.service.js';
import { NotificationsService } from '../../platform/notifications/notifications.service.js';
import { recordSnapshot, recordView } from '../../platform/records/record.js';
import { RevisionsService } from '../../platform/revisions/revisions.service.js';
import { NamingSeriesService } from '../../platform/sequences/naming-series.service.js';
import { SubscriptionsService } from '../../platform/subscriptions/subscriptions.service.js';
import { NoteBatchPublicationWorkflow } from './note-publication.workflow.js';
import { NotePublisher } from './note-publisher.service.js';
import { NOTE } from './note.record.js';
import { NOTE_RESOURCE } from './note.resource.js';
import type { Note } from './note.schemas.js';
import { notes } from './notes.tables.js';

/**
 * A note's words as the batch writes take them: the create body (POST
 * /notes), whose `custom` and `namingSeriesId` the generated DTO types loosely.
 */
export interface NoteInput {
  title: string;
  body: string;
  custom?: Record<string, unknown>;
  namingSeriesId?: string;
}

/** A note's revision state, as RecordLifecycle keeps it (the batch writes record it themselves). */
const snapshotOf = (note: Note) => recordSnapshot(NOTE, recordView(NOTE, note));

/**
 * The writes an import group makes (NoteTransfer): many notes in one
 * transaction, with their side effects grouped (one publication workflow,
 * one UPDATE for a group of edits), where NotesService.create and update
 * would do each note's own. Business logic: it is the batch twin of those two.
 */
@Injectable()
export class NoteBatch {
  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly workflowClient: WorkflowClient,
    private readonly webhooks: Webhooks<Transaction>,
    private readonly publisher: NotePublisher,
    private readonly customFields: CustomFieldsService,
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly approvals: ApprovalsService,
    private readonly tenancy: Tenancy,
    private readonly units: OrganizationalUnitsService,
    private readonly quotas: TenantQuotas,
    private readonly namingSeries: NamingSeriesService,
    private readonly revisions: RevisionsService,
  ) {}

  /** Creates one import group under one transaction and grouped side effects. */
  async createMany(
    owner: Principal,
    dtos: readonly NoteInput[],
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
      const unitId =
        owner.kind === 'user'
          ? await this.units.onlyUnitOf(owner.id, tx)
          : null;
      const created = await tx
        .insert(notes)
        .values(
          dtos.map((dto, index) => ({
            number: numbers[index]!.formatted,
            ownerId: principalKey(owner),
            unitId,
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
        NOTE_RESOURCE,
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
          snapshot: snapshotOf(note),
          by,
        })),
      );
      return created;
    });
    this.webhooks.notify();
    return rows;
  }

  /** Applies a group of edits with one row lock query and one UPDATE FROM VALUES. */
  async updateMany(
    by: Principal,
    matches: readonly { noteId: string; dto: Partial<NoteInput> }[],
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
      // One set-based UPDATE for the batch, not one per imported note: each
      // column takes its note's value by id. The rows are locked above and
      // every value was worked out from them, so an unchanged field is
      // written back as it is.
      const byId = (value: (item: (typeof changes)[number]) => SQL) =>
        sql`case ${notes.id} ${sql.join(
          changes.map((item) => sql`when ${item.id} then ${value(item)}`),
          sql` `,
        )} end`;
      await tx
        .update(notes)
        .set({
          title: byId((item) => sql`${item.title}::text`),
          body: byId((item) => sql`${item.body}::text`),
          custom: byId((item) => sql`${JSON.stringify(item.custom)}::jsonb`),
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            notes.id,
            changes.map((item) => item.id),
          ),
        );
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
        NOTE_RESOURCE,
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
          snapshot: snapshotOf(row),
          before: snapshotOf(beforeByUpdated.get(row.id)!),
          by,
        })),
      );
      return after;
    });
    this.notifications.deliverNow();
    return updated;
  }
}
