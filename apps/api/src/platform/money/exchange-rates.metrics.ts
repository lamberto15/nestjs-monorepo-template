import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import type { PlatformEnv } from '../platform.env.js';
import { ECB, ExchangeRatesService } from './exchange-rates.service.js';

/**
 * How old the newest ECB rates are, on core's `/metrics`: seconds since
 * the start (00:00 UTC) of the newest stored day. Normally under a day and
 * a half on weekdays, about four days on a Monday morning; it keeps growing
 * while ExchangeRatesJob can't fetch (the ExchangeRatesStale alert).
 * `+Inf` while nothing was ever stored. Absent with EXCHANGE_RATES_FETCH=off.
 * Shared state: every instance reports the same, aggregate with max().
 */
@Injectable()
export class ExchangeRatesMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly rates: ExchangeRatesService,
    private readonly config: ConfigService<PlatformEnv, true>,
  ) {}

  onModuleInit() {
    if (!this.config.get('EXCHANGE_RATES_FETCH', { infer: true })) {
      return;
    }
    this.metrics.collect(
      'exchange_rates_age_seconds',
      'Seconds since the start (00:00 UTC) of the newest stored ECB reference rates day (+Inf: none yet).',
      async () => {
        const newest = await this.rates.newestDay(ECB.source);
        return [
          {
            value: newest
              ? (Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 1000
              : Number.POSITIVE_INFINITY,
          },
        ];
      },
    );
  }
}
