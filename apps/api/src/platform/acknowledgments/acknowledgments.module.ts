import { Module } from '@nestjs/common';
import { AcknowledgmentsService } from './acknowledgments.service.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { PeopleModule } from '../people/people.module.js';
import { AccountModule } from '../account/account.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';

/**
 * The acknowledgments capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [
    PlatformKernelModule,
    PeopleModule,
    AccountModule,
    AttachmentsModule,
  ],
  providers: [
    // Acknowledgments of an attachment's version.
    AcknowledgmentsService,
  ],
  exports: [AcknowledgmentsService],
})
export class AcknowledgmentsModule {}
