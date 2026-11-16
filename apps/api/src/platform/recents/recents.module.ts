import { Module } from '@nestjs/common';
import { RecentsService } from './recents.service.js';
import { RecentsRetentionJob } from './recents-retention.job.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { AccountModule } from '../account/account.module.js';
import { RecentsController } from './recents.controller.js';

/**
 * The recents capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, AccountModule],
  controllers: [RecentsController],
  providers: [
    // Recently opened records: a person's bounded, expiring history.
    RecentsService,
    RecentsRetentionJob,
  ],
  exports: [RecentsService],
})
export class RecentsModule {}
