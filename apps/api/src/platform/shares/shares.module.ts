import { Module } from '@nestjs/common';
import { SharesRegistry } from './shares.registry.js';
import { SharesService } from './shares.service.js';
import { ShareCodeMail } from './share.mails.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';

/**
 * The shares capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [AttachmentsModule],
  providers: [
    // Read-only links to records: features register a ShareTarget (the `share` capability).
    SharesRegistry,
    SharesService,
    ShareCodeMail,
  ],
  exports: [SharesRegistry, SharesService],
})
export class SharesModule {}
