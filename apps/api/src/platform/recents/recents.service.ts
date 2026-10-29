import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  principalKey,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { RecordPurgeRegistry } from '../../iam/resources/record-purge.registry.js';
import {
  type PersonalDataSource,
  PersonalDataRegistry,
} from '../account/personal-data.registry.js';
import { SubscriptionsRegistry } from '../subscriptions/subscriptions.registry.js';
import {
  MAX_RECENTS,
  RECENTS_RETENTION_DAYS,
  type RecordRecentDto,
} from './recent.schemas.js';
import { recentRecords } from './recents.tables.js';

type Row = typeof recentRecords.$inferSelect;

/**
 * A person's recently opened records: bounded (MAX_RECENTS, the oldest drops
 * out), not older than RECENTS_RETENTION_DAYS, their own alone. Recording
 * checks they see the record (a subject's SubscriptionTarget, as favorites
 * and watching do), and the list checks again, leaving out what they no
 * longer see or what is gone, so a title is never shown for a record they
 * may not read. In their data export, cleared by them any time, and gone
 * with their account, the record's purge and the nightly sweep.
 */
@Injectable()
export class RecentsService implements PersonalDataSource {
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly targets: SubscriptionsRegistry,
    personalData: PersonalDataRegistry,
    purges: RecordPurgeRegistry,
  ) {
    personalData.register(this);
    purges.register({
      name: 'recents',
      forget: (tx, subject, ids) => this.forgetAll(tx, subject, ids),
    });
  }

  /** As a personal data source: the person's recent records are in their export… */
  readonly name = 'recent';
  async *rows(user: UserPrincipal) {
    const rows = await this.db
      .select()
      .from(recentRecords)
      .where(eq(recentRecords.owner, principalKey(user)))
      .orderBy(desc(recentRecords.viewedAt));
    if (rows.length) yield rows.map((row) => this.item(row));
  }

  /** …and go with their account. */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .delete(recentRecords)
      .where(eq(recentRecords.owner, principalKey(user)));
  }

  /** The principal's recent records, newest first, without what they no longer see. */
  async list(principal: RequestPrincipal) {
    const rows = await this.db
      .select()
      .from(recentRecords)
      .where(
        and(
          eq(recentRecords.owner, principalKey(principal)),
          gt(recentRecords.viewedAt, this.cutoff()),
        ),
      )
      .orderBy(desc(recentRecords.viewedAt), desc(recentRecords.id))
      .limit(MAX_RECENTS);
    const seen = await Promise.all(
      rows.map((row) => this.sees(principal, row)),
    );
    return {
      items: rows.filter((_, i) => seen[i]).map((row) => this.item(row)),
    };
  }

  /** Notes that the principal opened a record they see: first in their list, and the list stays bounded. */
  async record(principal: RequestPrincipal, dto: RecordRecentDto) {
    await this.assertSees(principal, dto);
    const owner = principalKey(principal);
    return inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .insert(recentRecords)
        .values({ ...dto, owner })
        .onConflictDoUpdate({
          target: [
            recentRecords.tenantId,
            recentRecords.owner,
            recentRecords.subject,
            recentRecords.recordId,
          ],
          set: { label: dto.label, viewedAt: new Date() },
        })
        .returning();
      // Past the bound: the oldest go.
      const [{ total }] = await tx
        .select({ total: count() })
        .from(recentRecords)
        .where(eq(recentRecords.owner, owner));
      if (total > MAX_RECENTS) {
        const stale = await tx
          .select({ id: recentRecords.id })
          .from(recentRecords)
          .where(eq(recentRecords.owner, owner))
          .orderBy(desc(recentRecords.viewedAt), desc(recentRecords.id))
          .offset(MAX_RECENTS);
        await tx.delete(recentRecords).where(
          inArray(
            recentRecords.id,
            stale.map((s) => s.id),
          ),
        );
      }
      return this.item(row!);
    });
  }

  /** Removes one of the principal's recent records, or a 404. */
  async remove(principal: RequestPrincipal, id: string) {
    const deleted = await inTransaction(this.txHost, (tx) =>
      tx
        .delete(recentRecords)
        .where(
          and(
            eq(recentRecords.id, id),
            eq(recentRecords.owner, principalKey(principal)),
          ),
        )
        .returning({ id: recentRecords.id }),
    );
    if (deleted.length === 0) {
      throw new NotFoundException(`Recent record ${id} not found.`);
    }
  }

  /** Clears the principal's history in this tenant. */
  async clear(principal: RequestPrincipal) {
    await inTransaction(this.txHost, (tx) =>
      tx
        .delete(recentRecords)
        .where(eq(recentRecords.owner, principalKey(principal))),
    );
  }

  /** When records are gone for good: nobody's recent records any more. */
  async forgetAll(tx: Transaction, subject: string, recordIds: string[]) {
    await tx
      .delete(recentRecords)
      .where(
        and(
          eq(recentRecords.subject, subject),
          inArray(recentRecords.recordId, recordIds),
        ),
      );
  }

  /** The age past which an entry is expired. */
  private cutoff(now = Date.now()) {
    return new Date(now - RECENTS_RETENTION_DAYS * 86_400_000);
  }

  private async sees(
    principal: RequestPrincipal,
    recent: Pick<Row, 'subject' | 'recordId'>,
  ) {
    try {
      await this.assertSees(principal, recent);
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        return false;
      }
      throw error;
    }
  }

  /** A 404 unless the principal sees the record (as reading it would). */
  private async assertSees(
    principal: RequestPrincipal,
    recent: Pick<Row, 'subject' | 'recordId'> | RecordRecentDto,
  ) {
    const target = this.targets.find(recent.subject);
    if (!target) {
      throw new NotFoundException(`No records of ${recent.subject}.`);
    }
    await target.assertCanWatch(principal, recent.recordId);
  }

  private item(row: Row) {
    return {
      id: row.id,
      subject: row.subject,
      recordId: row.recordId,
      label: row.label,
      viewedAt: row.viewedAt.toISOString(),
    };
  }
}
