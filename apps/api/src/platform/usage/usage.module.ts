import { Module, type Provider } from '@nestjs/common';
import { whenOn } from '../switches.js';
import { UsageService } from './usage.service.js';
import { UsageRollupJob } from './usage-rollup.job.js';

/**
 * The usage capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // API clients' usage: counted per day and route, daily quotas, the nightly roll-up.
    // USAGE=off: no metering, no quota enforcement, no roll-up.
    ...whenOn<Provider>('USAGE', UsageService, UsageRollupJob),
  ],
  exports: [...whenOn('USAGE', UsageService)],
})
export class UsageModule {}
