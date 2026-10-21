import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { sql } from 'drizzle-orm';
import type { PlatformEnv } from '../platform.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import {
  allowedPrefix,
  smsCost,
  utcDay,
  utcMonthStart,
} from './messaging.policy.js';
import { messagingUsage } from './messaging.tables.js';

/** Why an SMS was not sent. */
export type SmsBlock =
  | 'prefix_not_allowed'
  | 'tenant_limit'
  | 'prefix_limit'
  | 'user_limit'
  | 'ip_limit'
  | 'budget_exceeded';

/** The share of the monthly budget at which the alert is raised. */
const BUDGET_WARNING = 0.8;

const SPEND_COUNTER = 'spend';

/** One counter a send takes from: its row (`day`, `counter`), the cap, and how much one send adds. */
interface Counter {
  day: string;
  counter: string;
  limit: number;
  reason: SmsBlock;
  step?: number;
}

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
 *   SMS_DAILY_LIMIT_PER_USER to one user;
 * - per UTC month, spend within SMS_MONTHLY_BUDGET_MINOR (the segments of the
 *   text times the prefix's price, SMS_PRICES), logged as an error when it
 *   passes 80 %;
 * - per client IP, at most SMS_DAILY_LIMIT_PER_IP codes a day (`reserveIp`,
 *   asked when the code is requested).
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
   * Takes one SMS from today's allowance and the month's budget: `{ ok: true }`,
   * or the reason it may not go. Call it right before sending, with the text
   * (its length sets the cost).
   */
  async reserve(
    userId: string,
    phone: string,
    text: string,
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
    const counters: Counter[] = [
      {
        day,
        counter: 'tenant',
        limit: get('SMS_DAILY_LIMIT_PER_TENANT'),
        reason: 'tenant_limit',
      },
      {
        day,
        counter: `prefix:${prefix}`,
        limit: get('SMS_DAILY_LIMIT_PER_PREFIX'),
        reason: 'prefix_limit',
      },
      {
        day,
        counter: `user:${userId}`,
        limit: get('SMS_DAILY_LIMIT_PER_USER'),
        reason: 'user_limit',
      },
    ];
    const budget = get('SMS_MONTHLY_BUDGET_MINOR');
    const cost = smsCost(
      text,
      prefix,
      this.config.get('SMS_PRICES', { infer: true }),
      get('SMS_PRICE_DEFAULT_MINOR'),
    );
    if (budget > 0 && cost > 0) {
      counters.push({
        day: utcMonthStart(now),
        counter: SPEND_COUNTER,
        limit: budget,
        reason: 'budget_exceeded',
        step: cost,
      });
    }
    let spent: number | undefined;
    try {
      await inTransaction(this.txHost, async (tx) => {
        for (const entry of counters) {
          const count = await this.increment(tx, entry);
          if (count > entry.limit) {
            throw new CapHit(entry.reason);
          }
          if (entry.counter === SPEND_COUNTER) spent = count;
        }
      });
    } catch (error) {
      if (error instanceof CapHit) {
        await this.countBlocked(error.reason, now);
        return { ok: false, reason: error.reason };
      }
      throw error;
    }
    if (
      spent !== undefined &&
      spent >= budget * BUDGET_WARNING &&
      spent - cost < budget * BUDGET_WARNING
    ) {
      // Crossed on this send: said once a month per tenant.
      this.logger.error('SMS spend passed 80 % of the monthly budget', {
        spent,
        budget,
      });
    }
    return { ok: true };
  }

  /**
   * Takes one code from the client IP's allowance for today (the IP is kept
   * only hashed): false when the cap is used up. Asked when a number is set,
   * so the refusal reaches the person in the request.
   */
  async reserveIp(ip: string, now = new Date()): Promise<boolean> {
    const limit = this.config.get('SMS_DAILY_LIMIT_PER_IP', { infer: true });
    const counter = `ip:${createHash('sha256').update(ip).digest('hex').slice(0, 24)}`;
    try {
      await inTransaction(this.txHost, async (tx) => {
        const count = await this.increment(tx, {
          day: utcDay(now),
          counter,
          limit,
          reason: 'ip_limit',
        });
        if (count > limit) throw new CapHit('ip_limit');
      });
    } catch (error) {
      if (error instanceof CapHit) {
        await this.countBlocked('ip_limit', now);
        return false;
      }
      throw error;
    }
    return true;
  }

  /** The counter after adding `step` (default 1): an atomic upsert. */
  private async increment(
    tx: Transaction,
    { day, counter, step = 1 }: Counter,
  ): Promise<number> {
    const [row] = await tx
      .insert(messagingUsage)
      .values({ day, counter, count: step })
      .onConflictDoUpdate({
        target: [
          messagingUsage.tenantId,
          messagingUsage.day,
          messagingUsage.counter,
        ],
        set: { count: sql`${messagingUsage.count} + ${step}` },
      })
      .returning({ count: messagingUsage.count });
    return row?.count ?? 0;
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
