import { ConfigService } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import { ResilienceModule, type ResiliencePreset } from '@nestjs/resilience';
import type { Config, CoreEnv } from '../../core/config/core.env.js';

/**
 * Calling other services. @nestjs/http-client: every client a feature
 * registers (`HttpClientModule.register({ name, baseUrl })`) gets these
 * defaults: a user-agent, a 10s timeout, retries of idempotent requests.
 * @nestjs/resilience: timeouts, retries, circuit breakers and bulkheads by
 * name, from the presets the features declare in PlatformModule.forRoot().
 */
export const integrations = (presets: Record<string, ResiliencePreset>) => [
  HttpClientModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: Config<CoreEnv>) => ({
      headers: { 'user-agent': config.get('SERVICE_NAME', { infer: true }) },
      timeout: '10s',
    }),
  }),
  ResilienceModule.forRoot({
    defaults: {
      timeout: '5s',
      retry: { attempts: 3, backoff: { delay: '200ms', maxDelay: '2s' } },
      circuitBreaker: {
        failureRateThreshold: 50,
        minimumCalls: 10,
        openDuration: '30s',
      },
    },
    presets,
  }),
];
