import { Module } from '@nestjs/common';
import { RevisionsRegistry } from './revisions.registry.js';
import { RevisionsService } from './revisions.service.js';
import { RevisionRetentionJob } from './revision-retention.job.js';
import { PeopleModule } from '../people/people.module.js';
import { AccountModule } from '../account/account.module.js';

/**
 * The revisions capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  imports: [PeopleModule, AccountModule],
  providers: [
    // Record revisions: features register a RevisionTarget and call RevisionsService.record().
    RevisionsRegistry,
    RevisionsService,
    RevisionRetentionJob,
  ],
  exports: [RevisionsRegistry, RevisionsService],
})
export class RevisionsModule {}
