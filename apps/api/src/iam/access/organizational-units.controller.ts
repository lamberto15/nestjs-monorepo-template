import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { UNIT_ROLES, UNIT_TYPES } from '../iam.tables.js';
import { AccessAdminService } from './access-admin.service.js';
import { OrganizationalUnitsService } from './organizational-units.service.js';
import { AccessPolicy } from './policies.js';

const unitSchema = z.object({
  id: z.uuid(),
  type: z
    .enum(UNIT_TYPES)
    .describe('A label of the unit: it grants nothing by itself.'),
  name: z.string(),
  parentId: z.uuid().nullable(),
  depth: z.number().int().describe('0 for a top-level unit.'),
  members: z.number().int().describe('Its current members (leads included).'),
  managedByScim: z
    .boolean()
    .describe(
      'The IdP manages it over SCIM: its name, place and members change there (409 `unit_managed_by_scim` here).',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const unitRowSchema = unitSchema.omit({
  depth: true,
  members: true,
  managedByScim: true,
});
const name = z.string().trim().min(1).max(120);
const createSchema = z.object({
  type: z.enum(UNIT_TYPES),
  name: name.describe('Unique among its siblings, ignoring case.'),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Leave out for a top-level unit.'),
});
const updateSchema = z.object({
  type: z.enum(UNIT_TYPES).optional(),
  name: name.optional(),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Moves the unit, with every unit under it; null: to the top.'),
});
const membershipSchema = z.object({
  id: z.uuid(),
  unitId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(UNIT_ROLES),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable().describe('Null: open-ended.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const unitMemberSchema = membershipSchema.extend({
  name: z.string().describe('The name on their account.'),
  email: z.string(),
});
const addMemberSchema = z.object({
  userId: z.uuid(),
  role: z.enum(UNIT_ROLES).optional().describe('Default: member.'),
  validFrom: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Default: now. Later: dated ahead (a re-org).'),
  validTo: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional()
    .describe('Default: open-ended.'),
});
const changeMemberSchema = z.object({ role: z.enum(UNIT_ROLES) });

/**
 * The tenant's organizational units (one tree of divisions, departments
 * and teams), what the unit conditions (`inMyUnits`, `inMyUnitsAndBelow`,
 * `inUnitsILeadAndBelow`) read, and who belongs to them. Users also join
 * units as members with `unitIds` when a user is created or invited; after
 * that, these routes are the one way to change a membership.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Controller('access/organizational-units')
export class OrganizationalUnitsController {
  constructor(
    private readonly units: OrganizationalUnitsService,
    private readonly admin: AccessAdminService,
  ) {}

  @Get()
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'Every organizational unit, top-level first, with its depth',
  })
  @ApiOkResponse({ standardSchema: listSchema(unitSchema) })
  async list() {
    return { items: await this.units.list() };
  }

  @Post()
  @Can(AccessPolicy, 'manageOrganizationalUnits')
  @ApiOperation({ summary: 'Create an organizational unit' })
  @ApiCreatedResponse({ standardSchema: unitRowSchema })
  @ApiConflictResponse({
    description: '`unit_name_taken`: a sibling has the name (any case).',
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createSchema }) body: z.infer<typeof createSchema>,
    @Ip() ip: string,
  ) {
    return this.units.create(user, body, ip);
  }

  @Patch(':id')
  @Can(AccessPolicy, 'manageOrganizationalUnits')
  @ApiOperation({
    summary:
      'Rename or retype an organizational unit, or move it with everything under it',
  })
  @ApiOkResponse({ standardSchema: unitRowSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      '`unit_name_taken`; `unit_managed_by_scim`: the IdP manages it; or a move under itself.',
  })
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>,
    @Ip() ip: string,
  ) {
    return this.units.update(user, id, body, ip);
  }

  @Delete(':id')
  @Can(AccessPolicy, 'manageOrganizationalUnits')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty organizational unit' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      '`unit_not_empty`: units under it, current members, or records or saved views of it; or `unit_managed_by_scim`.',
  })
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.units.remove(user, id, ip);
  }

  @Get(':id/members')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: "A unit's memberships, current and ended, latest first",
  })
  @ApiOkResponse({ standardSchema: listSchema(unitMemberSchema) })
  @ApiNotFoundResponse()
  async members(@Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.units.members(id) };
  }

  @Post(':id/members')
  @Can(AccessPolicy, 'manageUsers')
  @ApiOperation({
    summary: 'Add a user to a unit, as a member or its lead, optionally dated',
  })
  @ApiCreatedResponse({ standardSchema: membershipSchema })
  @ApiForbiddenResponse({
    description: 'Yourself, or `authority_required`.',
  })
  @ApiConflictResponse({
    description: 'Already a member; or `unit_managed_by_scim`.',
  })
  addMember(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: addMemberSchema }) body: z.infer<typeof addMemberSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.addUnitMember(user, id, body, ip);
  }

  @Patch(':id/members/:userId')
  @Can(AccessPolicy, 'manageUsers')
  @ApiOperation({
    summary:
      "Change a member's role: their membership ends now and a new one starts",
  })
  @ApiOkResponse({ standardSchema: membershipSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: '`unit_managed_by_scim`.' })
  changeMember(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body({ schema: changeMemberSchema })
    body: z.infer<typeof changeMemberSchema>,
    @Ip() ip: string,
  ) {
    return this.admin.changeUnitMemberRole(user, id, userId, body.role, ip);
  }

  @Delete(':id/members/:userId')
  @Can(AccessPolicy, 'manageUsers')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a user from a unit: their membership ends now (kept)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: '`unit_managed_by_scim`.' })
  async removeMember(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Ip() ip: string,
  ) {
    await this.admin.removeUnitMember(user, id, userId, ip);
  }
}
