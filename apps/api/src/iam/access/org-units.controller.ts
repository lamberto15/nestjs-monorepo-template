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
import { OrgUnitsService } from './org-units.service.js';
import { AccessPolicy } from './policies.js';

const unitSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  parentId: z.uuid().nullable(),
  depth: z.number().int().describe('0 for a top-level unit.'),
  members: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Leave out for a top-level unit.'),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Moves the unit, with every unit under it; null: to the top.'),
});

/**
 * The organization's units (a tree): what `inMyUnits` conditions read. Put
 * users in units with `orgUnitIds` on /access/users.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Controller('access/org-units')
export class OrgUnitsController {
  constructor(private readonly units: OrgUnitsService) {}

  @Get()
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'Every org unit, top-level first, with its parent and depth',
  })
  @ApiOkResponse({ standardSchema: listSchema(unitSchema) })
  async list() {
    return { items: await this.units.list() };
  }

  @Post()
  @Can(AccessPolicy, 'manageOrgUnits')
  @ApiOperation({ summary: 'Create a unit' })
  @ApiCreatedResponse({
    standardSchema: unitSchema.omit({ depth: true, members: true }),
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createSchema }) body: z.infer<typeof createSchema>,
    @Ip() ip: string,
  ) {
    return this.units.create(user, body, ip);
  }

  @Patch(':id')
  @Can(AccessPolicy, 'manageOrgUnits')
  @ApiOperation({
    summary: 'Rename a unit, or move it with everything under it',
  })
  @ApiOkResponse({
    standardSchema: unitSchema.omit({ depth: true, members: true }),
  })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>,
    @Ip() ip: string,
  ) {
    return this.units.update(user, id, body, ip);
  }

  @Delete(':id')
  @Can(AccessPolicy, 'manageOrgUnits')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty unit' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: 'It still has units under it, or members.',
  })
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.units.remove(user, id, ip);
  }
}
