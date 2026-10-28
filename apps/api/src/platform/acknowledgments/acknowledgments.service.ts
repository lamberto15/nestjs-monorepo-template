import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import { AttachmentsRegistry } from '../attachments/attachments.registry.js';
import { AttachmentsService } from '../attachments/attachments.service.js';
import {
  type Attachment,
  attachments,
} from '../attachments/attachments.tables.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PeopleService } from '../people/people.service.js';
import {
  type AcknowledgmentView,
  MAX_PER_VERSION,
  type MyAcknowledgmentView,
} from './acknowledgment.schemas.js';
import {
  type DocumentAcknowledgment,
  documentAcknowledgments as acks,
} from './acknowledgments.tables.js';

/** A reminder goes to the same person at most this often. */
export const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A list of someone's own acknowledgments holds at most this many. */
const MINE_LIMIT = 100;

/**
 * The version of a document an acknowledgment is for. Attachments are not
 * versioned yet, so every document is version 1; when they are (#590), this
 * is the one place that reads the attachment's current version, and the
 * `version` column of existing rows is that version's number.
 */
export const versionOf = (_attachment: Attachment) => 1;

/**
 * "Did these people read this version of this document?": a request per
 * person and version, answered by the person (no signature is implied: it
 * records who confirmed, which version, when). Whoever may change the
 * document's record asks, reminds, withdraws and sees the dashboard; the
 * recipient (who must still read the record) acknowledges; asking again or
 * acknowledging again changes nothing. Every write is audited
 * (`acknowledgment.requested`, `-reminded`, `-withdrawn`,
 * `-acknowledged`); a removed document takes its rows (the audit log keeps
 * the answers).
 */
@Injectable()
export class AcknowledgmentsService implements PersonalDataSource {
  readonly name = 'acknowledgments';

  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly attachments: AttachmentsService,
    private readonly registry: AttachmentsRegistry,
    private readonly audit: AuditService,
    private readonly users: UsersRepository,
    private readonly notifications: NotificationsService,
    private readonly people: PeopleService,
    personalData: PersonalDataRegistry,
  ) {
    personalData.register(this);
  }

  /** Asks the people to acknowledge the document's current version; those already asked keep their answer (a new deadline replaces the old for those who haven't answered). */
  async request(
    principal: Principal,
    attachmentId: string,
    recipients: string[],
    dueAt: string | undefined,
    ip?: string,
  ) {
    const attachment = await this.writable(principal, attachmentId);
    const due = dueAt ? new Date(dueAt) : null;
    if (due && due.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'acknowledgment_due_in_past',
        message: 'The deadline must be in the future.',
      });
    }
    const keys = [...new Set(recipients)];
    await this.assertRecipients(attachment, keys);
    const version = versionOf(attachment);
    const by = principalKey(principal);
    const saved = await inTransaction(this.txHost, async (tx) => {
      const [existing] = await tx
        .select({ total: count() })
        .from(acks)
        .where(
          and(eq(acks.attachmentId, attachment.id), eq(acks.version, version)),
        );
      const have = await tx
        .select()
        .from(acks)
        .where(
          and(
            eq(acks.attachmentId, attachment.id),
            eq(acks.version, version),
            inArray(acks.recipient, keys),
          ),
        );
      const fresh = keys.filter(
        (key) => !have.some((row) => row.recipient === key),
      );
      if ((existing?.total ?? 0) + fresh.length > MAX_PER_VERSION) {
        throw new ConflictException({
          code: 'acknowledgment_limit',
          message: `A version takes at most ${MAX_PER_VERSION} people.`,
        });
      }
      if (fresh.length) {
        await tx.insert(acks).values(
          fresh.map((recipient) => ({
            attachmentId: attachment.id,
            version,
            recipient,
            requestedBy: by,
            dueAt: due,
          })),
        );
      }
      if (due) {
        const open = have.filter((row) => !row.acknowledgedAt);
        if (open.length) {
          await tx
            .update(acks)
            .set({ dueAt: due })
            .where(
              inArray(
                acks.id,
                open.map((row) => row.id),
              ),
            );
        }
      }
      if (fresh.length) {
        await this.audit.record(
          principal,
          {
            action: 'acknowledgment.requested',
            targetType: 'attachment',
            targetId: attachment.id,
            details: {
              version,
              name: attachment.name,
              recipients: fresh,
              dueAt: due?.toISOString() ?? null,
            },
            ip,
          },
          tx,
        );
        await this.tell(
          tx,
          'acknowledgment.requested',
          attachment,
          version,
          principal,
          fresh,
          due,
        );
      }
      return tx
        .select()
        .from(acks)
        .where(
          and(
            eq(acks.attachmentId, attachment.id),
            eq(acks.version, version),
            inArray(acks.recipient, keys),
          ),
        );
    });
    this.notifications.deliverNow();
    return this.views(saved);
  }

  /** The completion dashboard of a version (default: the current one). */
  async status(principal: Principal, attachmentId: string, version?: number) {
    const attachment = await this.writable(principal, attachmentId);
    const v = version ?? versionOf(attachment);
    const found = await this.db
      .select()
      .from(acks)
      .where(and(eq(acks.attachmentId, attachment.id), eq(acks.version, v)))
      .orderBy(acks.createdAt, acks.id);
    const items = await this.views(found);
    const acknowledged = items.filter((i) => i.acknowledgedAt).length;
    return {
      attachmentId: attachment.id,
      version: v,
      total: items.length,
      acknowledged,
      pending: items.length - acknowledged,
      overdue: items.filter((i) => i.overdue).length,
      items,
    };
  }

  /** Records that the caller acknowledged the document's current version; again, or a version they were not asked about, changes nothing. */
  async acknowledge(principal: Principal, attachmentId: string, ip?: string) {
    const attachment = await this.attachments.findReadable(
      principal,
      attachmentId,
    );
    const version = versionOf(attachment);
    const key = principalKey(principal);
    const [mine] = await this.db
      .select()
      .from(acks)
      .where(
        and(
          eq(acks.attachmentId, attachment.id),
          eq(acks.version, version),
          eq(acks.recipient, key),
        ),
      );
    if (!mine) {
      // Nobody asked them: the same answer as for a document they may not read.
      throw new NotFoundException(`Attachment ${attachmentId} not found.`);
    }
    if (mine.acknowledgedAt) return (await this.views([mine]))[0]!;
    const saved = await inTransaction(this.txHost, async (tx) => {
      const [updated] = await tx
        .update(acks)
        .set({ acknowledgedAt: new Date() })
        .where(and(eq(acks.id, mine.id), isNull(acks.acknowledgedAt)))
        .returning();
      if (!updated) return null; // A parallel request did it: nothing to audit.
      await this.audit.record(
        principal,
        {
          action: 'acknowledgment.acknowledged',
          targetType: 'attachment',
          targetId: attachment.id,
          details: { version, name: attachment.name },
          ip,
        },
        tx,
      );
      return updated;
    });
    if (!saved) {
      const [again] = await this.db
        .select()
        .from(acks)
        .where(eq(acks.id, mine.id));
      return (await this.views([again!]))[0]!;
    }
    return (await this.views([saved]))[0]!;
  }

  /** Reminds those who have not acknowledged (or the named ones), but not twice in 24 hours. */
  async remind(
    principal: Principal,
    attachmentId: string,
    recipients: string[] | undefined,
    ip?: string,
    now = new Date(),
  ) {
    const attachment = await this.writable(principal, attachmentId);
    const version = versionOf(attachment);
    const open = await this.db
      .select()
      .from(acks)
      .where(
        and(
          eq(acks.attachmentId, attachment.id),
          eq(acks.version, version),
          isNull(acks.acknowledgedAt),
          recipients?.length ? inArray(acks.recipient, recipients) : undefined,
        ),
      );
    const due = open.filter(
      (row) =>
        !row.lastRemindedAt ||
        now.getTime() - row.lastRemindedAt.getTime() >= REMINDER_INTERVAL_MS,
    );
    if (due.length) {
      await inTransaction(this.txHost, async (tx) => {
        await tx
          .update(acks)
          .set({ lastRemindedAt: now, reminders: sql`${acks.reminders} + 1` })
          .where(
            inArray(
              acks.id,
              due.map((row) => row.id),
            ),
          );
        await this.audit.record(
          principal,
          {
            action: 'acknowledgment.reminded',
            targetType: 'attachment',
            targetId: attachment.id,
            details: {
              version,
              name: attachment.name,
              recipients: due.map((r) => r.recipient),
            },
            ip,
          },
          tx,
        );
        for (const row of due) {
          await this.tell(
            tx,
            'acknowledgment.reminder',
            attachment,
            version,
            principal,
            [row.recipient],
            row.dueAt,
          );
        }
      });
      this.notifications.deliverNow();
    }
    return { reminded: due.length, skipped: open.length - due.length };
  }

  /** Withdraws a request nobody has answered; an answer stays. */
  async withdraw(
    principal: Principal,
    attachmentId: string,
    id: string,
    ip?: string,
  ) {
    const attachment = await this.writable(principal, attachmentId);
    const [row] = await this.db
      .select()
      .from(acks)
      .where(and(eq(acks.id, id), eq(acks.attachmentId, attachment.id)));
    if (!row) throw new NotFoundException(`Acknowledgment ${id} not found.`);
    if (row.acknowledgedAt) {
      throw new ConflictException({
        code: 'acknowledgment_answered',
        message: 'Already acknowledged: the answer stays.',
      });
    }
    await inTransaction(this.txHost, async (tx) => {
      await tx.delete(acks).where(eq(acks.id, id));
      await this.audit.record(
        principal,
        {
          action: 'acknowledgment.withdrawn',
          targetType: 'attachment',
          targetId: attachment.id,
          details: { version: row.version, recipient: row.recipient },
          ip,
        },
        tx,
      );
    });
  }

  /** The caller's own acknowledgments, newest first: the ones to do (`pending`) or done. */
  async mine(principal: Principal, status: 'pending' | 'acknowledged') {
    const found = await this.db
      .select({ row: acks, attachment: attachments })
      .from(acks)
      .innerJoin(attachments, eq(attachments.id, acks.attachmentId))
      .where(
        and(
          eq(acks.recipient, principalKey(principal)),
          status === 'pending'
            ? isNull(acks.acknowledgedAt)
            : isNotNull(acks.acknowledgedAt),
        ),
      )
      .orderBy(desc(acks.id))
      .limit(MINE_LIMIT);
    // Only documents whose record they may still read.
    const readable: typeof found = [];
    for (const item of found) {
      const target = this.registry.get(item.attachment.subject);
      if (
        target &&
        (await target.canRead(principal, item.attachment.recordId))
      ) {
        readable.push(item);
      }
    }
    const views = await this.views(readable.map((item) => item.row));
    return {
      items: views.map((view, index): MyAcknowledgmentView => ({
        ...view,
        document: {
          name: readable[index]!.attachment.name,
          subject: readable[index]!.attachment.subject,
          recordId: readable[index]!.attachment.recordId,
        },
      })),
    };
  }

  /** A user's own acknowledgments, for their data export. */
  async *rows(user: UserPrincipal) {
    const found = await this.db
      .select()
      .from(acks)
      .where(eq(acks.recipient, principalKey(user)));
    if (found.length) {
      yield found.map((row) => ({
        id: row.id,
        attachmentId: row.attachmentId,
        version: row.version,
        dueAt: row.dueAt?.toISOString() ?? null,
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      }));
    }
  }

  /** An account's deletion: their requests and answers go (the audit log keeps the answers, by key). */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx.delete(acks).where(eq(acks.recipient, principalKey(user)));
  }

  /** The document, once the principal may change its record (a 404 if they may not read it, a 403 if they may not change it). */
  private async writable(principal: Principal, id: string) {
    const attachment = await this.attachments.findReadable(principal, id);
    const target = this.registry.get(attachment.subject)!;
    if (!(await target.canWrite(principal, attachment.recordId))) {
      throw new ForbiddenException(
        'You may not ask for acknowledgments of this document.',
      );
    }
    return attachment;
  }

  /** Active members of the tenant who may read the record, else a 400 (a requester may use the people directory). */
  private async assertRecipients(attachment: Attachment, keys: string[]) {
    const tenantId = requireTenantId('An acknowledgment');
    const target = this.registry.get(attachment.subject)!;
    for (const key of keys) {
      const user = await this.users.inTenant(
        key.slice('user:'.length),
        tenantId,
      );
      if (
        !user ||
        user.tenantId !== tenantId ||
        !(await target.canRead(user, attachment.recordId))
      ) {
        throw new BadRequestException({
          code: 'acknowledgment_recipient_invalid',
          message: `${key} is not a member who may read this document.`,
        });
      }
    }
  }

  private async tell(
    tx: Transaction,
    type: 'acknowledgment.requested' | 'acknowledgment.reminder',
    attachment: Attachment,
    version: number,
    by: Principal,
    to: string[],
    due: Date | null,
  ) {
    await this.notifications.notify(tx, {
      type,
      to,
      data: {
        attachmentId: attachment.id,
        version,
        name: attachment.name,
        by: by.name,
        dueAt: due?.toISOString() ?? null,
      },
    });
  }

  private async views(
    found: DocumentAcknowledgment[],
  ): Promise<AcknowledgmentView[]> {
    const names = await this.people.names(found.map((row) => row.recipient));
    const now = Date.now();
    return found.map((row) => ({
      id: row.id,
      attachmentId: row.attachmentId,
      version: row.version,
      recipient: row.recipient,
      recipientName: names.get(row.recipient) ?? null,
      requestedBy: row.requestedBy,
      dueAt: row.dueAt?.toISOString() ?? null,
      overdue: !row.acknowledgedAt && !!row.dueAt && row.dueAt.getTime() < now,
      reminders: row.reminders,
      lastRemindedAt: row.lastRemindedAt?.toISOString() ?? null,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
