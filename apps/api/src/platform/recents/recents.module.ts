import { Module } from '@nestjs/common';
import { RecentsService } from './recents.service.js';
import { RecentsRetentionJob } from './recents-retention.job.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { AccountModule } from '../account/account.module.js';

/**
 * The recents capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, AccountModule],
  providers: [
    // Recently opened records: a person's bounded, expiring history.
    RecentsService,
    RecentsRetentionJob,
  ],
  exports: [RecentsService],
})
export class RecentsModule {}
