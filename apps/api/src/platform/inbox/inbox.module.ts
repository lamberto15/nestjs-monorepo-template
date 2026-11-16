import { Module } from '@nestjs/common';
import { InboxRegistry } from './inbox.registry.js';
import { InboxService } from './inbox.service.js';
import { InboxController } from './inbox.controller.js';

/**
 * The inbox capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [InboxController],
  providers: [
    // The work inbox: sources (approvals, mentions) register, one list merges them.
    InboxRegistry,
    InboxService,
  ],
  exports: [InboxRegistry, InboxService],
})
export class InboxModule {}
