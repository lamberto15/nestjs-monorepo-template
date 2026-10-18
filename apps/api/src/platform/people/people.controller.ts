import { Controller, Get, Query } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { listSchema } from '../../core/http/pagination.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import {
  type PeopleQuery,
  peopleQuerySchema,
  personSchema,
} from './people.schemas.js';
import { PeopleService } from './people.service.js';

/**
 * The tenant's people, as every member may see them (docs/permissions.md,
 * "The people directory"): names and keys, for @mention autocomplete.
 * Users only: an API client has no one to mention. The global throttle
 * bounds how fast it can be read.
 */
@ApiTags('people')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session or user token.' })
@UserOnly()
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @Can.Anyone() // Any member of the tenant: only names and keys, of its active members.
  @ApiOperation({
    summary: "Your tenant's people, by name: for @mentions",
    description:
      "The active members of your tenant whose name contains `q`, by name: each one's key (`user:<id>`, what `@user:<id>` mentions) and name, nothing else. For any member. A mention still reaches only those who may read the record (docs/comments.md).",
  })
  @ApiOkResponse({ standardSchema: listSchema(personSchema) })
  @ApiBadRequestResponse({
    description: '`q` empty or longer than 100 characters, `limit` over 20.',
  })
  @ApiForbiddenResponse({
    description: 'Your session acts in no tenant (tenant_required).',
  })
  async list(@Query({ schema: peopleQuerySchema }) query: PeopleQuery) {
    return { items: await this.people.directory(query.q, query.limit) };
  }
}
