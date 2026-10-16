import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import type { PlatformEnv } from '../platform.env.js';
import { ECB_RATES, ExchangeRatesJob } from './exchange-rates.job.js';
import { ExchangeRatesMetrics } from './exchange-rates.metrics.js';
import { ExchangeRatesService } from './exchange-rates.service.js';
import { MoneyController } from './money.controller.js';
// The library's errors as problem details.
import './money-errors.js';

/**
 * Money and currency (docs/money.md). The library (`Money`, `formatMoney()`,
 * `moneyColumns()`, the Zod schemas) is plain code features import; this
 * module adds the exchange rates: their table, the job that fetches the
 * ECB's, the service that converts, `/v1/money/rates` and
 * `/v1/money/convert`. PlatformModule imports it and exports
 * ExchangeRatesService to the features.
 */
@Module({
  imports: [
    // The ECB's eurofxref documents. The platform's HttpClientModule.forRootAsync()
    // gives the user-agent; GETs are retried (3 attempts) on network errors and 5xx.
    HttpClientModule.registerAsync({
      name: ECB_RATES,
      inject: [ConfigService],
      useFactory: (config: ConfigService<PlatformEnv, true>) => ({
        baseUrl: config.get('EXCHANGE_RATES_ECB_URL', { infer: true }),
        timeout: '20s',
      }),
    }),
  ],
  controllers: [MoneyController],
  providers: [ExchangeRatesService, ExchangeRatesJob, ExchangeRatesMetrics],
  exports: [ExchangeRatesService],
})
export class MoneyModule {}
