import { Module } from '@nestjs/common';
import { PeopleService } from './people.service.js';
import { ACTOR_NAMES } from '../../iam/audit/actor-names.js';

/**
 * The people capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule, which keeps the routes
 * (platform.module.ts).
 */
@Module({
  providers: [
    // The names behind principal keys, and the directory @mentions search.
    PeopleService,
    // The audit log's actor names (iam/audit, `actorName`): the people directory's.
    { provide: ACTOR_NAMES, useExisting: PeopleService },
  ],
  exports: [PeopleService, ACTOR_NAMES],
})
export class PeopleModule {}
