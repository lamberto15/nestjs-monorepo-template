import { Module } from '@nestjs/common';
import { PeopleService } from './people.service.js';
import { ACTOR_NAMES } from '../../iam/audit/actor-names.js';
import {
  PeopleController,
  UnitDirectoryController,
} from './people.controller.js';

/**
 * The people capability's routes and providers, exporting what the rest of
 * the platform, IAM, core and the features inject. Imported by
 * PlatformModule (platform.module.ts).
 */
@Module({
  controllers: [
    // The tenant's people and units, for @mentions and pickers (GET /v1/people, GET /v1/organizational-units).
    PeopleController,
    UnitDirectoryController,
  ],
  providers: [
    // The names behind principal keys, and the directory @mentions search.
    PeopleService,
    // The audit log's actor names (iam/audit, `actorName`): the people directory's.
    { provide: ACTOR_NAMES, useExisting: PeopleService },
  ],
  exports: [PeopleService, ACTOR_NAMES],
})
export class PeopleModule {}
