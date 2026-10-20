import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { sql } from 'drizzle-orm';
import type { PlatformEnv } from '../platform.env.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { allowedPrefix, utcDay } from './messaging.policy.js';
import { messagingUsage } from './messaging.tables.js';

/** Why an SMS was not sent. */
export type SmsBlock =
  'prefix_not_allowed' | 'tenant_limit' | 'prefix_limit' | 'user_limit';

/** Rolls the reservation's transaction back when a cap is hit. */
class CapHit extends Error {
  constructor(readonly reason: SmsBlock) {
    super(reason);
  }
}

/**
 * The toll-fraud caps of SMS (docs/notifications.md, "Push and SMS"), checked
 * by the worker just before each send, in the job's tenant:
 *
 * - the destination must start with an allowed prefix (SMS_ALLOWED_PREFIXES);
 * - per day (UTC), at most SMS_DAILY_LIMIT_PER_TENANT in the tenant,
 *   SMS_DAILY_LIMIT_PER_PREFIX to one prefix in it, and
 *   SMS_DAILY_LIMIT_PER_USER to one user.
 *
 * The counters are incremented in one transaction with an atomic upsert, so
 * the caps hold under concurrent workers, and the transaction rolls back
 * when one is hit: a refused SMS uses none of the allowance. A refusal is
 * counted apart (`blocked:<reason>`), which the metrics show, and logged as
 * an error: the signal to alert on.
 */
@Injectable()
export class MessagingLimits {
  private readonly logger = new Logger('Messaging');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  /** The allowed prefix of `phone`, or null. */
  prefixOf(phone: string) {
    return allowedPrefix(
      phone,
      this.config.get('SMS_ALLOWED_PREFIXES', { infer: true }),
    );
  }

  /**
   * Takes one SMS from today's allowance: `{ ok: true }`, or the reason it
   * may not go. Call it right before sending.
   */
  async reserve(
    userId: string,
    phone: string,
    now = new Date(),
  ): Promise<{ ok: true } | { ok: false; reason: SmsBlock }> {
    const prefix = this.prefixOf(phone);
    if (!prefix) {
      await this.countBlocked('prefix_not_allowed', now);
      return { ok: false, reason: 'prefix_not_allowed' };
    }
    const day = utcDay(now);
    const get = (name: keyof PlatformEnv) =>
      this.config.get(name, { infer: true }) as number;
    const counters: [string, number, SmsBlock][] = [
      ['tenant', get('SMS_DAILY_LIMIT_PER_TENANT'), 'tenant_limit'],
      [`prefix:${prefix}`, get('SMS_DAILY_LIMIT_PER_PREFIX'), 'prefix_limit'],
      [`user:${userId}`, get('SMS_DAILY_LIMIT_PER_USER'), 'user_limit'],
    ];
    try {
      await inTransaction(this.txHost, async (tx) => {
        for (const [counter, limit, reason] of counters) {
          const [row] = await tx
            .insert(messagingUsage)
            .values({ day, counter, count: 1 })
            .onConflictDoUpdate({
              target: [
                messagingUsage.tenantId,
                messagingUsage.day,
                messagingUsage.counter,
              ],
              set: { count: sql`${messagingUsage.count} + 1` },
            })
            .returning({ count: messagingUsage.count });
          if ((row?.count ?? 0) > limit) {
            throw new CapHit(reason);
          }
        }
      });
    } catch (error) {
      if (error instanceof CapHit) {
        await this.countBlocked(error.reason, now);
        return { ok: false, reason: error.reason };
      }
      throw error;
    }
    return { ok: true };
  }

  /** Counts a refusal and logs it as an error (what an alert reads). */
  private async countBlocked(reason: SmsBlock, now: Date) {
    this.logger.error('SMS blocked by the toll-fraud caps', { reason });
    await this.db
      .insert(messagingUsage)
      .values({ day: utcDay(now), counter: `blocked:${reason}`, count: 1 })
      .onConflictDoUpdate({
        target: [
          messagingUsage.tenantId,
          messagingUsage.day,
          messagingUsage.counter,
        ],
        set: { count: sql`${messagingUsage.count} + 1` },
      });
  }
}
