import { Module } from '@nestjs/common';
import { JobIndex } from './job-index.js';

/**
 * The queues capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // Who queued which transfers and bulk runs (their lists).
    JobIndex,
  ],
  exports: [JobIndex],
})
export class QueuesModule {}
