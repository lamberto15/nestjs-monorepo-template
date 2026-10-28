import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { serveFile, StorageDisk } from '@nestjs/storage';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import {
  DEFAULT_LIMIT,
  listSchema,
  MAX_LIMIT,
  pageSchema,
} from '../../core/http/pagination.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { AVATAR_TYPES } from '../account/avatar.js';
import { AvatarService } from '../account/avatar.service.js';
import { FILE_CSP } from '../storage/files.controller.js';
import {
  type AvatarQuery,
  avatarQuerySchema,
  type PeopleQuery,
  peopleQuerySchema,
  personSchema,
  unitRefSchema,
  type UnitsQuery,
  unitsQuerySchema,
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
    private readonly disk: StorageDisk,
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
  @Can.Anyone() // Any member of the tenant, for a member of it (or yourself); checked by the service.
  @ApiOperation({
    summary: "A person's picture",
    description:
      "The picture itself (what `avatarUrl` of a person points at), streamed by this API rather than redirected to the disk's signed link: an `<img>` then loads it from the page's own origin, whatever the storage (a redirect to another origin, the bucket with S3, is refused by the browser's cross-origin and Content-Security-Policy rules). `Content-Disposition: inline`, `Cache-Control: private` (the address changes with the picture), `nosniff`. For a member (or former member) of your tenant, or yourself. 404 when they have none, or are no one of your tenant: the two are not told apart.",
  })
  @ApiProduces(...AVATAR_TYPES)
  @ApiOkResponse({
    description: 'The picture: a PNG, JPEG, WebP or GIF.',
    content: Object.fromEntries(
      AVATAR_TYPES.map((type) => [
        type,
        { schema: { type: 'string', format: 'binary' } },
      ]),
    ),
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse({
    description: 'Your session acts in no tenant (tenant_required).',
  })
  async avatar(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: avatarQuerySchema }) _query: AvatarQuery,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = await this.avatars.keyOf(user, id);
    // Like any served file: it loads nothing and no page frames it.
    res.setHeader('Content-Security-Policy', FILE_CSP);
    return serveFile(this.disk, key, {
      req,
      res,
      disposition: 'inline',
      // The address carries the version (`?v=`), so a new picture is a new
      // address; `private` keeps a shared cache from holding it.
      cacheControl: 'private, max-age=300',
    });
  }
}

/**
 * The tenant's units, as every member may see them (docs/permissions.md,
 * "The units lookup"): id, name and place in the tree, for the
 * pickers and names of a list's `ref: unit` fields (`unitId`). Managing
 * units (and their members) stays on /v1/access/organizational-units. Users only, as
 * GET /v1/people.
 */
@ApiTags('people')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session or user token.' })
@UserOnly()
@Controller('organizational-units')
export class UnitDirectoryController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @Can.Anyone() // Any member of the tenant: only the units' ids, names and tree.
  @ApiOperation({
    summary: "Your tenant's organizational units: names and tree, for pickers",
    description: `Every organizational unit of your tenant, newest first in cursor pages (\`limit\`: ${DEFAULT_LIMIT} a page by default, ${MAX_LIMIT} at most; follow \`nextCursor\` to read them all): its id (what \`unitId\` holds), name, parent and depth, nothing else. \`q\`: a part of the name; \`id=<id>,<id>\`: these units (${MAX_LIMIT} ids at most; an id your tenant has no unit of is left out). For any member; managing units is /v1/access/organizational-units.`,
  })
  @ApiOkResponse({
    standardSchema: pageSchema(unitRefSchema).pick({
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
  list(@Query({ schema: unitsQuerySchema }) query: UnitsQuery) {
    return this.people.units(query);
  }
}
