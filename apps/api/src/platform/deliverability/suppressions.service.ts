import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import {
  type MailSuppression,
  normalizeAddress,
  SUPPRESSION_REASONS,
  type SuppressionReason,
  type SuppressionVerdict,
} from '../../core/mail/mail-suppression.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { uniqueToConflict } from '../../iam/access/api-clients.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import { defineResource } from '../../iam/resources/resource.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import type { PlatformEnv } from '../platform.env.js';
import { mailEvents, mailSuppressions } from './deliverability.tables.js';
import type { MailEvent } from './mail-event.types.js';
import { MAIL_SUPPRESSION_LIST } from './suppression.list.js';
import type {
  CreateMailSuppressionDto,
  MailSuppressionView,
} from './suppression.schemas.js';

type Suppression = typeof mailSuppressions.$inferSelect;

/** Audited as `mailSuppression.created` / `.updated` (what changed) / `.deleted`. */
export const MAIL_SUPPRESSION = defineResource({
  subject: 'MailSuppression',
  // Counters change on every event and every skipped mail: no entry for those.
  audit: { ignore: ['events', 'softBounces', 'skipped', 'lastSkippedAt'] },
});

/** Which reason wins when a new report arrives for a listed address: a fact beats a decision. */
const RANK: Record<SuppressionReason, number> = {
  complaint: 3,
  hard_bounce: 2,
  manual: 1,
  soft_bounce: 0,
};

const iso = (date: Date | null) => (date ? date.toISOString() : null);

const view = (row: Suppression): MailSuppressionView => ({
  ...row,
  reason: row.reason as SuppressionReason,
  firstSeenAt: row.firstSeenAt.toISOString(),
  lastSeenAt: row.lastSeenAt.toISOString(),
  suppressedAt: iso(row.suppressedAt),
  lastSkippedAt: iso(row.lastSkippedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** What applying a batch of events changed. */
export interface AppliedEvents {
  /** Events recorded (the rest were replays). */
  recorded: number;
  /** Addresses suppressed by this batch. */
  suppressed: string[];
}

/**
 * The suppression list (docs/deliverability.md): the addresses mail is not
 * sent to, kept from the bounces and complaints providers report
 * (`apply`, by the intake's queue job as `system:mail-intake`) and by
 * administrators (`create`, `remove`; `MailSuppression.manage`). The mail
 * queue's worker asks it before every send (`check`, the core's
 * `MAIL_SUPPRESSION` token). Entries hold email addresses: a user's own
 * are in their data export and go with their account (PersonalDataSource).
 * Each write is one transaction with its audit entry.
 */
@Injectable()
export class SuppressionsService
  implements MailSuppression, PersonalDataSource
{
  readonly name = 'mailSuppression';
  private readonly logger = new Logger('MailSuppressions');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly audit: AuditService,
    private readonly config: ConfigService<PlatformEnv, true>,
    personalData: PersonalDataRegistry,
    metrics: MetricsService,
  ) {
    personalData.register(this);
    metrics.collect(
      'mail_suppressions',
      'Addresses on the suppression list (mail is not sent to them), by reason.',
      async () => {
        const rows = await this.db
          .select({ reason: mailSuppressions.reason, value: count() })
          .from(mailSuppressions)
          .where(isNotNull(mailSuppressions.suppressedAt))
          .groupBy(mailSuppressions.reason);
        return SUPPRESSION_REASONS.map((reason) => ({
          labels: { reason },
          value: rows.find((row) => row.reason === reason)?.value ?? 0,
        }));
      },
      ['reason'],
    );
  }

  /** A page of entries, newest first unless the query sorts. */
  async list(query: ListQuery) {
    const where = MAIL_SUPPRESSION_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(mailSuppressions)
        .where(and(where, afterCursor(mailSuppressions.id, query)))
        .orderBy(...pageOrder(mailSuppressions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, mailSuppressions, where, query),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map(view) };
  }

  async findOne(id: string) {
    const [row] = await this.db
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.id, id));
    if (!row) {
      throw new NotFoundException(`Suppression ${id} not found.`);
    }
    return view(row);
  }

  /** Whether a soft-bounce suppression has run its MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS. */
  private softBounceExpired(row: Suppression, now: Date) {
    const hours = this.config.get('MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS', {
      infer: true,
    });
    return (
      row.reason === 'soft_bounce' &&
      row.suppressedAt !== null &&
      now.getTime() - row.suppressedAt.getTime() > hours * 3_600_000
    );
  }

  /**
   * The sender's question (core/mail/mail-suppression.ts): a listed
   * address is skipped, unless the mail is essential and the mailbox
   * exists (a complaint, a soft bounce): the person asked for that mail,
   * and a soft bounce must never lock them out of account recovery. A
   * soft-bounce suppression older than MAIL_SOFT_BOUNCE_SUPPRESSION_HOURS
   * has expired: the entry goes back to watched-only here (lazily, when
   * the address is next written to) and the mail goes out. Skips are
   * counted on the entry, outside any transaction (the worker has none;
   * a failed count never fails the mail).
   */
  async check(
    addresses: readonly string[],
    { essential, mail }: { essential: boolean; mail: string },
  ) {
    const verdicts = new Map<string, SuppressionVerdict>();
    const wanted = [...new Set(addresses.map(normalizeAddress))];
    if (wanted.length === 0) {
      return verdicts;
    }
    const rows = await this.db
      .select()
      .from(mailSuppressions)
      .where(
        and(
          inArray(mailSuppressions.address, wanted),
          isNotNull(mailSuppressions.suppressedAt),
        ),
      );
    const now = new Date();
    const skipped: string[] = [];
    const expired: string[] = [];
    for (const row of rows) {
      const reason = row.reason as SuppressionReason;
      if (this.softBounceExpired(row, now)) {
        expired.push(row.id);
        continue;
      }
      if (essential && (reason === 'complaint' || reason === 'soft_bounce')) {
        continue; // asked for by the person, and the mailbox exists: goes out
      }
      verdicts.set(row.address, { send: false, reason });
      skipped.push(row.address);
    }
    if (expired.length > 0) {
      await this.db
        .update(mailSuppressions)
        .set({ suppressedAt: null, softBounces: 0 })
        .where(inArray(mailSuppressions.id, expired));
      this.logger.log('Soft-bounce suppressions expired', {
        expired: expired.length,
      });
    }
    if (skipped.length > 0) {
      await this.db
        .update(mailSuppressions)
        .set({
          skipped: sql`${mailSuppressions.skipped} + 1`,
          lastSkippedAt: now,
        })
        .where(inArray(mailSuppressions.address, skipped));
      this.logger.log('Mail kept from suppressed addresses', {
        mail,
        skipped: skipped.length,
      });
    }
    return verdicts;
  }

  /**
   * Records a provider's events and keeps the list from them, in one
   * transaction: each event once (the unique index on provider, message
   * and address makes a redelivery a no-op), then per address: a hard
   * bounce or a complaint suppresses it (a stronger reason replaces a
   * weaker one), a soft bounce is counted and suppresses it at
   * MAIL_SOFT_BOUNCE_THRESHOLD in a row, a delivery resets that count.
   * The audit log gets an entry when an address becomes suppressed or its
   * reason changes, as `system`.
   */
  async apply(
    system: Principal,
    provider: string,
    id: string,
    events: readonly MailEvent[],
  ): Promise<AppliedEvents> {
    return inTransaction(this.txHost, async (tx) => {
      const result: AppliedEvents = { recorded: 0, suppressed: [] };
      for (const event of events) {
        const address = normalizeAddress(event.address);
        const occurredAt = new Date(event.occurredAt);
        const [recorded] = await tx
          .insert(mailEvents)
          .values({
            provider,
            eventId: id,
            type: event.type,
            address,
            occurredAt: Number.isNaN(occurredAt.getTime())
              ? new Date()
              : occurredAt,
            detail: event.detail ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: mailEvents.id });
        if (!recorded) {
          continue; // a replay
        }
        result.recorded++;
        if (await this.applyOne(tx, system, provider, address, event)) {
          result.suppressed.push(address);
        }
      }
      return result;
    });
  }

  /**
   * One event on one address; true when the address became suppressed.
   * Soft bounces count within MAIL_SOFT_BOUNCE_WINDOW_HOURS of the last
   * one (an older count starts over), and an expired soft-bounce
   * suppression counts as none.
   */
  private async applyOne(
    tx: Transaction,
    system: Principal,
    provider: string,
    address: string,
    event: MailEvent,
  ) {
    const [current] = await tx
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.address, address))
      .for('update');
    const now = new Date();
    const expired = current ? this.softBounceExpired(current, now) : false;
    const wasSuppressed = !!current?.suppressedAt && !expired;
    if (event.type === 'delivery') {
      if (current && (current.softBounces > 0 || expired) && !wasSuppressed) {
        await tx
          .update(mailSuppressions)
          .set({ softBounces: 0, suppressedAt: null, lastSeenAt: now })
          .where(eq(mailSuppressions.id, current.id));
      }
      return false;
    }
    const threshold = this.config.get('MAIL_SOFT_BOUNCE_THRESHOLD', {
      infer: true,
    });
    const windowMs =
      this.config.get('MAIL_SOFT_BOUNCE_WINDOW_HOURS', { infer: true }) *
      3_600_000;
    const recentSoft =
      current &&
      !expired &&
      now.getTime() - current.lastSeenAt.getTime() <= windowMs
        ? current.softBounces
        : 0;
    const softBounces = event.type === 'soft_bounce' ? recentSoft + 1 : 0;
    const reason: SuppressionReason = event.type;
    // What this event says the entry should be, on its own.
    const suppressNow = reason !== 'soft_bounce' || softBounces >= threshold;
    if (!current) {
      const [created] = await tx
        .insert(mailSuppressions)
        .values({
          address,
          reason,
          source: provider,
          lastDetail: event.detail ?? null,
          events: 1,
          softBounces,
          firstSeenAt: now,
          lastSeenAt: now,
          suppressedAt: suppressNow ? now : null,
          createdBy: principalKey(system),
        })
        .returning();
      if (suppressNow) {
        await this.audit.recordChange(
          system,
          MAIL_SUPPRESSION,
          { action: 'created', id: created!.id, after: created! },
          tx,
        );
      }
      return suppressNow;
    }
    const upgrade =
      suppressNow &&
      (!wasSuppressed ||
        RANK[reason] > RANK[current.reason as SuppressionReason]);
    const [updated] = await tx
      .update(mailSuppressions)
      .set({
        events: current.events + 1,
        softBounces,
        lastSeenAt: now,
        lastDetail: event.detail ?? current.lastDetail,
        ...(upgrade
          ? {
              reason,
              source: provider,
              suppressedAt: wasSuppressed ? current.suppressedAt : now,
            }
          : expired && { suppressedAt: null }),
      })
      .where(eq(mailSuppressions.id, current.id))
      .returning();
    if (upgrade) {
      await this.audit.recordChange(
        system,
        MAIL_SUPPRESSION,
        wasSuppressed
          ? {
              action: 'updated',
              id: current.id,
              before: current,
              after: updated!,
            }
          : { action: 'created', id: current.id, after: updated! },
        tx,
      );
    }
    return upgrade && !wasSuppressed;
  }

  /** An administrator's entry; a 409 when the address is listed already. */
  async create(
    principal: Principal,
    dto: CreateMailSuppressionDto,
    ip?: string,
  ) {
    const address = normalizeAddress(dto.address);
    const now = new Date();
    const row = await inTransaction(this.txHost, async (tx) => {
      const [created] = await tx
        .insert(mailSuppressions)
        .values({
          address,
          reason: 'manual',
          source: 'manual',
          note: dto.note || null,
          firstSeenAt: now,
          lastSeenAt: now,
          suppressedAt: now,
          createdBy: principalKey(principal),
        })
        .returning();
      await this.audit.recordChange(
        principal,
        MAIL_SUPPRESSION,
        { action: 'created', id: created!.id, after: created! },
        tx,
        ip,
      );
      return created!;
    }).catch((error: unknown) => {
      throw uniqueToConflict(error, `${address} is on the list already.`);
    });
    return view(row);
  }

  /**
   * Removes an entry: mail goes to the address again. For a bounced
   * address, once the mailbox is known to work; for a complaint, only
   * when the person asked for mail again. The events stay (the trail);
   * a new report lists it again.
   */
  async remove(principal: Principal, id: string, ip?: string) {
    await inTransaction(this.txHost, async (tx) => {
      // Read under the lock, so the audit entry's `before` is what was deleted.
      const [row] = await tx
        .select()
        .from(mailSuppressions)
        .where(eq(mailSuppressions.id, id))
        .for('update');
      if (!row) {
        throw new NotFoundException(`Suppression ${id} not found.`);
      }
      await tx.delete(mailSuppressions).where(eq(mailSuppressions.id, id));
      await this.audit.recordChange(
        principal,
        MAIL_SUPPRESSION,
        { action: 'deleted', id, before: row },
        tx,
        ip,
      );
    });
  }

  /** The entries and events for the user's own address (their data export). */
  async *rows(user: UserPrincipal) {
    const address = normalizeAddress(user.email);
    const entries = await this.db
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.address, address));
    if (entries.length > 0) {
      yield entries.map((row) => ({ ...view(row) }));
    }
    const events = await this.db
      .select()
      .from(mailEvents)
      .where(eq(mailEvents.address, address))
      .orderBy(desc(mailEvents.id))
      .limit(1000);
    if (events.length > 0) {
      yield events.map((event) => ({
        ...event,
        occurredAt: event.occurredAt.toISOString(),
        createdAt: event.createdAt.toISOString(),
      }));
    }
  }

  /**
   * With the account: the address is personal data, and once the account
   * is gone nothing mails it. A new report after that lists it again.
   */
  async erase(tx: Transaction, user: UserPrincipal) {
    const address = normalizeAddress(user.email);
    await tx.delete(mailEvents).where(eq(mailEvents.address, address));
    await tx
      .delete(mailSuppressions)
      .where(eq(mailSuppressions.address, address));
  }
}
