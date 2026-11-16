import { Module } from '@nestjs/common';
import { InboxRegistry } from './inbox.registry.js';
import { InboxService } from './inbox.service.js';

/**
 * The inbox capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // The work inbox: sources (approvals, mentions) register, one list merges them.
    InboxRegistry,
    InboxService,
  ],
  exports: [InboxRegistry, InboxService],
})
export class InboxModule {}
