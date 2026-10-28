import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type Type,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Counter } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service.js';
import { REDIS } from '../redis/redis.js';
import { TenantQuotas } from '../tenancy/tenant-quotas.js';
import { currentTenantId, tenantKey } from '../tenancy/tenant-scope.js';
import { isEssentialMail } from './mail-suppression.js';

/** Which mail leaves (the platform's `mail.delivery` setting). */
export const MAIL_DELIVERY_MODES = ['all', 'essential', 'off'] as const;
export type MailDeliveryMode = (typeof MAIL_DELIVERY_MODES)[number];

/** The daily budgets (UTC days); null: none. */
export interface MailBudget {
  /** Mails a day for the whole deployment: the provider's quota. */
  daily: number | null;
  /** Mails a day for the current tenant (its `mailsPerDay` quota). */
  tenantDaily: number | null;
  /** Past this share of a budget, only essential mail is queued. */
  essentialOnlyPercent: number;
}

/** The current tenant's mode and budgets; the platform provides them from its settings. */
export interface MailDelivery {
  mode(): Promise<MailDeliveryMode>;
  budget(): Promise<MailBudget>;
}

export const MAIL_DELIVERY = Symbol('MAIL_DELIVERY');

/** Why a mail was not queued. */
const WITHHELD_REASONS = ['policy', 'budget', 'tenant_budget'] as const;
type WithheldReason = (typeof WITHHELD_REASONS)[number];

/** A day's counter outlives the day, so a late reader still finds it. */
const COUNTER_TTL_SECONDS = 2 * 24 * 3600;

const NO_BUDGET: MailBudget = {
  daily: null,
  tenantDaily: null,
  essentialOnlyPercent: 100,
};

/** The mails queued on `now`'s UTC day: the deployment's, or a tenant's. */
export const mailCountKey = (now: Date, tenantId?: string) => {
  const key = `mail:queued:${now.toISOString().slice(0, 10)}`;
  return tenantId ? tenantKey(key, tenantId) : key;
};

/**
 * Decides, before a mail is queued, whether it may go (#618): a mail storm
 * (100k notes published at once) must not fill Redis with mail jobs nor use
 * up the provider's quota, and the mail a person needs to sign in must still
 * leave. Essential mail is the one marked `@EssentialMail()`, or sent as
 * essential (`MailQueue.send(…, { essential: true })`: a mandatory
 * notification type).
 *
 * - The mode (`mail.delivery`): `all`, `essential` (only essential mail) or
 *   `off`. An operator sets it for every tenant, enforced, in an incident.
 * - Daily budgets (UTC): the mails queued today are counted in Redis across
 *   every replica, for the deployment (`mail.dailyLimit`, the provider's
 *   quota) and for the tenant (its `mailsPerDay` quota); past
 *   `mail.essentialOnlyPercent` of either, a non-essential mail is withheld.
 *   Essential mail is counted but never withheld by a budget: the
 *   provider's own quota is the last word.
 *
 * A withheld mail is not queued, logged, and counted in
 * `mail_withheld_total{reason}`.
 */
@Injectable()
export class MailDeliveryGate {
  private readonly logger = new Logger('MailQueue');
  private readonly withheld: Counter<'reason'>;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    metrics: MetricsService,
    quotas: TenantQuotas,
    @Optional()
    @Inject(MAIL_DELIVERY)
    private readonly delivery?: MailDelivery,
  ) {
    // The tenant's usage (GET /tenants/{id}/quotas): today's count.
    quotas.count(
      'mailsPerDay',
      async (_db, tenantId) =>
        Number(await this.redis.get(mailCountKey(new Date(), tenantId))) || 0,
    );
    this.withheld = new Counter({
      name: 'mail_withheld_total',
      help: 'Mails not queued: the mail.delivery mode or the daily budget kept them, by reason.',
      labelNames: ['reason'] as const,
      registers: [metrics.registry],
    });
    for (const reason of WITHHELD_REASONS) {
      this.withheld.labels(reason).inc(0);
    }
    // How near the provider's quota today is, before mail is withheld (MailBudgetNearCap).
    metrics.collect(
      'mail_budget_used_ratio',
      "Share of the deployment's daily mail budget (mail.dailyLimit) queued today (UTC); absent without one.",
      async () => {
        const { daily } = await this.budget();
        if (!daily) return [];
        const queued =
          Number(await this.redis.get(mailCountKey(new Date()))) || 0;
        return [{ value: queued / daily }];
      },
    );
  }

  /** Whether `mail` may be queued now; a withheld one is logged and counted. */
  async admit(
    mail: Type<unknown>,
    options: { essential?: boolean; now?: Date } = {},
  ): Promise<boolean> {
    const { now = new Date() } = options;
    const essential = isEssentialMail(mail) || options.essential === true;
    const mode = await this.mode();
    if (mode === 'off' || (mode === 'essential' && !essential)) {
      return this.withhold('policy', mail, { mode });
    }
    const budget = await this.budget();
    const tenantId = currentTenantId();
    // Counted with no budget too: a tenant's usage shows today's mail.
    const counters: {
      reason: WithheldReason;
      key: string;
      limit: number | null;
    }[] = [{ reason: 'budget', key: mailCountKey(now), limit: budget.daily }];
    if (tenantId) {
      counters.push({
        reason: 'tenant_budget',
        key: mailCountKey(now, tenantId),
        limit: budget.tenantDaily,
      });
    }
    const queued = this.redis.multi();
    for (const { key } of counters) {
      queued.incr(key).expire(key, COUNTER_TTL_SECONDS);
    }
    const results = await queued.exec();
    const counts = counters.map((_, index) =>
      Number(results?.[index * 2]?.[1]),
    );
    if (essential) {
      counters.forEach(({ limit }, index) => {
        if (limit !== null && counts[index]! > limit) {
          this.logger.warn('Essential mail queued over a daily mail limit', {
            mail: mail.name,
            count: counts[index],
            limit,
          });
        }
      });
      return true;
    }
    const over = counters.find(
      ({ limit }, index) =>
        limit !== null &&
        counts[index]! >
          Math.floor((limit * budget.essentialOnlyPercent) / 100),
    );
    if (over) {
      // Not queued: it doesn't use the allowance.
      for (const { key } of counters) await this.redis.decr(key);
      return this.withhold(over.reason, mail, {
        limit: over.limit,
        essentialOnlyPercent: budget.essentialOnlyPercent,
      });
    }
    return true;
  }

  /** The budgets, none when no platform provides them or they can't be read (as `mode()`). */
  private async budget(): Promise<MailBudget> {
    try {
      return (await this.delivery?.budget()) ?? NO_BUDGET;
    } catch (error) {
      this.logger.warn('Mail budget unreadable: no budget applies', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NO_BUDGET;
    }
  }

  /**
   * The mode, `all` when no platform provides it or it can't be read: a
   * settings outage must not keep back the mail a person needs to sign in.
   */
  private async mode(): Promise<MailDeliveryMode> {
    try {
      return (await this.delivery?.mode()) ?? 'all';
    } catch (error) {
      this.logger.warn('Mail delivery mode unreadable: every mail may go', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'all';
    }
  }

  private withhold(
    reason: WithheldReason,
    mail: Type<unknown>,
    details: Record<string, unknown>,
  ) {
    this.withheld.labels(reason).inc();
    this.logger.warn(`Mail withheld (${reason})`, {
      mail: mail.name,
      ...details,
    });
    return false;
  }
}
