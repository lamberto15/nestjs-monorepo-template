import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Redirect,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiFoundResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  DEFAULT_LIMIT,
  listSchema,
  MAX_LIMIT,
  pageSchema,
} from '../../core/http/pagination.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { AvatarService } from '../account/avatar.service.js';
import {
  type AvatarQuery,
  avatarQuerySchema,
  type PeopleQuery,
  peopleQuerySchema,
  personSchema,
  teamRefSchema,
  type TeamsQuery,
  teamsQuerySchema,
} from './people.schemas.js';
import { PeopleService } from './people.service.js';

/**
 * The tenant's people, as every member may see them (docs/permissions.md,
 * "The people directory"): names and keys, for @mention autocomplete and
 * for the names behind keys a page holds (`ref: principal`). Users only:
 * an API client has no one to mention or pick. The global throttle bounds
 * how fast it can be read.
 */
@ApiTags('people')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session or user token.' })
@UserOnly()
@Controller('people')
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly avatars: AvatarService,
  ) {}

  @Get()
  @Can.Anyone() // Any member of the tenant: only names and keys, of its members and former members.
  @ApiOperation({
    summary:
      "Your tenant's people, by name or by key: for @mentions and pickers",
    description:
      'With `q` (or nothing): the active members of your tenant whose name contains `q`, by name. With `key=user:<id>,client:<id>`: the names of these keys, in the order asked: a member, or a former member (they still own records), or an API client of your tenant; a key your tenant has no one for is left out (no error). Each item is a key (`user:<id>`, what `@user:<id>` mentions and `ownerId` holds) and a name, nothing else. For any member. A mention still reaches only those who may read the record (docs/comments.md).',
  })
  @ApiOkResponse({ standardSchema: listSchema(personSchema) })
  @ApiBadRequestResponse({
    description:
      '`q` empty or longer than 100 characters, `limit` over 20, a `key` that is not `user:<uuid>` or `client:<uuid>`, more than 20 keys, or `q` with `key` (validation_failed).',
  })
  @ApiForbiddenResponse({
    description: 'Your session acts in no tenant (tenant_required).',
  })
  async list(@Query({ schema: peopleQuerySchema }) query: PeopleQuery) {
    return {
      items: query.key
        ? await this.people.named(query.key)
        : await this.people.directory(query.q, query.limit),
    };
  }

  @Get(':id/avatar')
  @Redirect()
  @Can.Anyone() // Any member of the tenant, for a member of it (or yourself); checked by the service.
  @ApiOperation({
    summary: "A person's picture",
    description:
      'Redirects to a signed link to the picture (5 minutes, needs no credentials: an `<img>` follows it); what `avatarUrl` of a person points at. For a member (or former member) of your tenant, or yourself. 404 when they have none, or are no one of your tenant: the two are not told apart.',
  })
  @ApiFoundResponse({ description: 'To the picture (a signed link).' })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse({
    description: 'Your session acts in no tenant (tenant_required).',
  })
  avatar(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: avatarQuerySchema }) _query: AvatarQuery,
  ) {
    return this.avatars.link(user, id);
  }
}

/**
 * The tenant's teams, as every member may see them (docs/permissions.md,
 * "The teams lookup"): id, name and place in the tree, for the
 * pickers and names of a list's `ref: team` fields (`teamId`). Managing
 * teams (and their members) stays on /v1/access/teams. Users only, as
 * GET /v1/people.
 */
@ApiTags('people')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session or user token.' })
@UserOnly()
@Controller('teams')
export class TeamDirectoryController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @Can.Anyone() // Any member of the tenant: only the teams' ids, names and tree.
  @ApiOperation({
    summary: "Your tenant's teams: names and tree, for pickers",
    description: `Every team of your tenant, newest first in cursor pages (\`limit\`: ${DEFAULT_LIMIT} a page by default, ${MAX_LIMIT} at most; follow \`nextCursor\` to read them all): its id (what \`teamId\` holds), name, parent and depth, nothing else. \`q\`: a part of the name; \`id=<id>,<id>\`: these teams (${MAX_LIMIT} ids at most; an id your tenant has no team of is left out). For any member; managing teams is /v1/access/teams.`,
  })
  @ApiOkResponse({
    standardSchema: pageSchema(teamRefSchema).pick({
      items: true,
      nextCursor: true,
    }),
  })
  @ApiBadRequestResponse({
    description:
      '`q` empty or longer than 100 characters, an `id` that is no UUID, more than 100 ids, `limit` over 100 (validation_failed).',
  })
  @ApiForbiddenResponse({
    description: 'Your session acts in no tenant (tenant_required).',
  })
  list(@Query({ schema: teamsQuerySchema }) query: TeamsQuery) {
    return this.people.teams(query);
  }
}
