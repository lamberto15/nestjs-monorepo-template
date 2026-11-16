import { Module } from '@nestjs/common';
import { PlatformAnalyticsJob } from './platform-analytics.job.js';

/**
 * The analytics capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Platform analytics: anonymized aggregates across tenants, for the reporting role, nightly.
    PlatformAnalyticsJob,
  ],
})
export class AnalyticsModule {}
