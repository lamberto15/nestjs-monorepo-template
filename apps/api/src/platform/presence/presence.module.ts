import { Module } from '@nestjs/common';
import { PresenceService } from './presence.service.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { PeopleModule } from '../people/people.module.js';

/**
 * The presence capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, PeopleModule],
  providers: [
    // Record presence: who is viewing or editing a record, ephemeral and advisory.
    PresenceService,
  ],
  exports: [PresenceService],
})
export class PresenceModule {}
