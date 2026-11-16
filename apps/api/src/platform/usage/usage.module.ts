import { Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { whenOn } from '../switches.js';
import { UsageService } from './usage.service.js';
import { UsageRollupJob } from './usage-rollup.job.js';
import { UsageController } from './usage.controller.js';
import { UsageInterceptor } from './usage.interceptor.js';

/**
 * The usage capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [...whenOn('USAGE', UsageController)],
  providers: [
    // API clients' usage: counted per day and route, daily quotas, the nightly roll-up.
    // USAGE=off: no metering, no quota enforcement, no roll-up.
    ...whenOn<Provider>('USAGE', UsageService, UsageRollupJob, {
      // The meter, global. Its place among the global interceptors is this
      // module's among PlatformModule's imports: right after IdempotencyModule
      // (test/global-enhancers.e2e-spec.ts).
      provide: APP_INTERCEPTOR,
      useClass: UsageInterceptor,
    }),
  ],
  exports: [...whenOn('USAGE', UsageService)],
})
export class UsageModule {}
