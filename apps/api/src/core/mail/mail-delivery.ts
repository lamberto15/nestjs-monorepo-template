import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { Counter } from 'prom-client';
import type { CoreEnv } from '../config/core.env.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { REDIS } from '../redis/redis.js';
import { isEssentialMail } from './mail-suppression.js';

/** Which mail leaves (the platform's `mail.delivery` setting). */
export const MAIL_DELIVERY_MODES = ['all', 'essential', 'off'] as const;
export type MailDeliveryMode = (typeof MAIL_DELIVERY_MODES)[number];

/** The current tenant's mode; the platform provides it from its settings. */
export interface MailDelivery {
  mode(): Promise<MailDeliveryMode>;
}

export const MAIL_DELIVERY = Symbol('MAIL_DELIVERY');

/** Why a mail was not queued. */
const WITHHELD_REASONS = ['policy', 'budget'] as const;
type WithheldReason = (typeof WITHHELD_REASONS)[number];

/** A day's counter outlives the day, so a late reader still finds it. */
const COUNTER_TTL_SECONDS = 2 * 24 * 3600;

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
 * - A daily budget (UTC): with MAIL_DAILY_LIMIT set, the mails queued today
 *   are counted in Redis across every replica, and a non-essential mail is
 *   withheld once the count reaches the limit minus
 *   MAIL_DAILY_ESSENTIAL_RESERVE. Essential mail is counted but never
 *   withheld by the budget: the provider's own quota is the last word.
 *
 * A withheld mail is not queued, logged, and counted in
 * `mail_withheld_total{reason}`.
 */
@Injectable()
export class MailDeliveryGate {
  private readonly logger = new Logger('MailQueue');
  private readonly withheld: Counter<'reason'>;

  constructor(
    private readonly config: ConfigService<CoreEnv, true>,
    @Inject(REDIS) private readonly redis: Redis,
    metrics: MetricsService,
    @Optional()
    @Inject(MAIL_DELIVERY)
    private readonly delivery?: MailDelivery,
  ) {
    this.withheld = new Counter({
      name: 'mail_withheld_total',
      help: 'Mails not queued: the mail.delivery mode or the daily budget kept them, by reason.',
      labelNames: ['reason'] as const,
      registers: [metrics.registry],
    });
    for (const reason of WITHHELD_REASONS) {
      this.withheld.labels(reason).inc(0);
    }
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
    const limit = this.config.get('MAIL_DAILY_LIMIT', { infer: true });
    if (limit === 0) return true;
    const key = `mail:queued:${now.toISOString().slice(0, 10)}`;
    const results = await this.redis
      .multi()
      .incr(key)
      .expire(key, COUNTER_TTL_SECONDS)
      .exec();
    const count = Number(results?.[0]?.[1]);
    if (essential) {
      if (count > limit) {
        this.logger.warn('Essential mail queued over the daily mail limit', {
          mail: mail.name,
          count,
          limit,
        });
      }
      return true;
    }
    const reserve = this.config.get('MAIL_DAILY_ESSENTIAL_RESERVE', {
      infer: true,
    });
    if (count > limit - reserve) {
      // Not queued: it doesn't use the allowance.
      await this.redis.decr(key);
      return this.withhold('budget', mail, { limit, reserve });
    }
    return true;
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
