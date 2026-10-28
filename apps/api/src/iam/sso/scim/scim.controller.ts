import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Ip,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { NodeResponse as Response } from '@nestjs/platform-node';
import { z } from 'zod';
import { AccessPolicy } from '../../access/policies.js';
import { ApiKeyAuth } from '../../auth/api-key-auth.provider.js';
import type { ClientPrincipal } from '../../auth/principal.js';
import {
  SCIM_CONTENT_TYPE,
  SCIM_SCHEMA,
  ScimErrorFilter,
} from './scim-error.filter.js';
import {
  type ScimGroupInput,
  scimGroupSchema,
  ScimGroupsService,
} from './scim-groups.service.js';
import {
  type ScimUserInput,
  scimUserSchema,
  ScimUsersService,
} from './scim-users.service.js';
import { minutes, Throttle } from '@nestjs/throttler';

const listQuerySchema = z.object({
  filter: z.string().optional(),
  startIndex: z.coerce.number().int().optional(),
  count: z.coerce.number().int().optional(),
  excludedAttributes: z.string().max(500).optional(),
});
type ListQuery = z.infer<typeof listQuerySchema>;

const SCIM_JSON = `${SCIM_CONTENT_TYPE}; charset=utf-8`;

const patchBody = {
  description: `A PatchOp (\`${SCIM_SCHEMA.patch}\`).`,
  schema: { type: 'object' as const },
};

/**
 * SCIM 2.0 (RFC 7643, RFC 7644) for the tenant's identity provider
 * (docs/auth.md, "SCIM provisioning"): base URL `{APP_URL}/v1/scim`. The
 * IdP's SCIM token is an API client's key (stored as its SHA-256, as every
 * key) whose role holds `Access.provisionScim`: its tenant is the one
 * provisioned. Errors are SCIM's (`application/scim+json`), not problem
 * details.
 *
 * Rate: an IdP's full sync (Entra ID, Okta) sends thousands of requests
 * from a handful of addresses, which the default per-address limit (600 a
 * minute) would cut short; SCIM gets ten times that, and the client's
 * daily quota (platform/usage) still meters it. Raised, not skipped: an
 * unknown token is throttled too.
 */
@Throttle({ default: { limit: 6000, ttl: minutes(1) } })
@ApiTags('scim')
@ApiBearerAuth('api-key')
@ApiProduces(SCIM_CONTENT_TYPE)
@ApiResponse({ status: 401, description: 'Missing or unknown SCIM token.' })
@ApiResponse({
  status: 403,
  description: 'The key’s client lacks `Access.provisionScim`.',
})
@Authenticate({ providers: [ApiKeyAuth] })
@Can(AccessPolicy, 'provisionScim')
@UseFilters(ScimErrorFilter)
@Controller('scim')
export class ScimController {
  constructor(
    private readonly users: ScimUsersService,
    private readonly groups: ScimGroupsService,
  ) {}

  @Get('ServiceProviderConfig')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({ summary: 'What this SCIM service supports (RFC 7643 §5)' })
  serviceProviderConfig() {
    return {
      schemas: [SCIM_SCHEMA.serviceProviderConfig],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description:
            'The SCIM token: an API client key with Access.provisionScim.',
          primary: true,
        },
      ],
    };
  }

  @Get('ResourceTypes')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({ summary: 'The resource types: User and Group (RFC 7643 §6)' })
  resourceTypes() {
    const types = [
      {
        schemas: [SCIM_SCHEMA.resourceType],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: SCIM_SCHEMA.user,
        schemaExtensions: [
          { schema: SCIM_SCHEMA.enterpriseUser, required: false },
        ],
      },
      {
        schemas: [SCIM_SCHEMA.resourceType],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        schema: SCIM_SCHEMA.group,
      },
    ];
    return {
      schemas: [SCIM_SCHEMA.list],
      totalResults: types.length,
      startIndex: 1,
      itemsPerPage: types.length,
      Resources: types,
    };
  }

  // Users

  @Get('Users')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({
    summary: 'The users provisioned over SCIM',
    description:
      'Filter: `eq` on `userName`, `externalId`, `id`, `emails.value` or `active`, joined with `and`. `startIndex` (1-based), `count` (at most 200).',
  })
  listUsers(@Query({ schema: listQuerySchema }) query: ListQuery) {
    return this.users.list(query);
  }

  @Get('Users/:id')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({ summary: 'One provisioned user' })
  getUser(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Post('Users')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({
    summary: 'Provision a user: an address of a verified domain',
    description:
      'Links the account with that address (when its address is proved) or makes one without a password, and makes it a member. 409 `uniqueness`: already provisioned, or the externalId is taken.',
  })
  @ApiConsumes(SCIM_CONTENT_TYPE, 'application/json')
  async createUser(
    @CurrentUser() client: ClientPrincipal,
    @Body({ schema: scimUserSchema }) body: ScimUserInput,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.users.create(client, body, ip);
    res.status(201).setHeader('Location', user.meta.location);
    return user;
  }

  @Put('Users/:id')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({
    summary: 'Replace a user: `active: false` deprovisions it',
  })
  @ApiConsumes(SCIM_CONTENT_TYPE, 'application/json')
  replaceUser(
    @CurrentUser() client: ClientPrincipal,
    @Param('id') id: string,
    @Body({ schema: scimUserSchema }) body: ScimUserInput,
    @Ip() ip: string,
  ) {
    return this.users.replace(client, id, body, ip);
  }

  @Patch('Users/:id')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({
    summary: 'Change a user (PatchOp): `replace active false` deprovisions it',
  })
  @ApiConsumes(SCIM_CONTENT_TYPE, 'application/json')
  @ApiBody(patchBody)
  patchUser(
    @CurrentUser() client: ClientPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Ip() ip: string,
  ) {
    return this.users.patch(client, id, body, ip);
  }

  @Delete('Users/:id')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Deprovision a user: the membership deactivated, its sessions in the tenant ended',
  })
  async deleteUser(
    @CurrentUser() client: ClientPrincipal,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    await this.users.remove(client, id, ip);
  }

  // Groups

  @Get('Groups')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({
    summary: 'The groups (organizational units) made over SCIM',
    description:
      'Filter: `eq` on `displayName`, `externalId` or `id`, joined with `and`. `excludedAttributes=members` leaves the members out.',
  })
  listGroups(@Query({ schema: listQuerySchema }) query: ListQuery) {
    return this.groups.list(query);
  }

  @Get('Groups/:id')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({ summary: 'One group, with its members' })
  getGroup(@Param('id') id: string) {
    return this.groups.get(id);
  }

  @Post('Groups')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({
    summary:
      'Make a group: a top-level unit of type team, its members provisioned users',
  })
  @ApiConsumes(SCIM_CONTENT_TYPE, 'application/json')
  async createGroup(
    @CurrentUser() client: ClientPrincipal,
    @Body({ schema: scimGroupSchema }) body: ScimGroupInput,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const group = await this.groups.create(client, body, ip);
    res.status(201).setHeader('Location', group.meta.location);
    return group;
  }

  @Put('Groups/:id')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({ summary: 'Replace a group: its name and members' })
  @ApiConsumes(SCIM_CONTENT_TYPE, 'application/json')
  replaceGroup(
    @CurrentUser() client: ClientPrincipal,
    @Param('id') id: string,
    @Body({ schema: scimGroupSchema }) body: ScimGroupInput,
    @Ip() ip: string,
  ) {
    return this.groups.replace(client, id, body, ip);
  }

  @Patch('Groups/:id')
  @Header('Content-Type', SCIM_JSON)
  @ApiOperation({
    summary: 'Change a group (PatchOp): members added or removed',
  })
  @ApiConsumes(SCIM_CONTENT_TYPE, 'application/json')
  @ApiBody(patchBody)
  patchGroup(
    @CurrentUser() client: ClientPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Ip() ip: string,
  ) {
    return this.groups.patch(client, id, body, ip);
  }

  @Delete('Groups/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a group: its unit goes, not its members' })
  async deleteGroup(
    @CurrentUser() client: ClientPrincipal,
    @Param('id') id: string,
    @Ip() ip: string,
  ) {
    await this.groups.remove(client, id, ip);
  }
}
