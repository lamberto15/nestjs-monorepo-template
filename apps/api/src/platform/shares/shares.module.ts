import { Module } from '@nestjs/common';
import { SharesRegistry } from './shares.registry.js';
import { SharesService } from './shares.service.js';
import { ShareCodeMail } from './share.mails.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { SharedController } from './shared.controller.js';

/**
 * The shares capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  imports: [AttachmentsModule],
  controllers: [
    // Opening a record's read-only link, without a sign-in (POST /v1/shared/open).
    SharedController,
  ],
  providers: [
    // Read-only links to records: features register a ShareTarget (the `share` capability).
    SharesRegistry,
    SharesService,
    ShareCodeMail,
  ],
  exports: [SharesRegistry, SharesService],
})
export class SharesModule {}
