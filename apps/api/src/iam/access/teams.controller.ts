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
import { TeamsService } from './teams.service.js';
import { AccessPolicy } from './policies.js';

const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  parentId: z.uuid().nullable(),
  depth: z.number().int().describe('0 for a top-level team.'),
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
    .describe('Leave out for a top-level team.'),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z
    .uuid()
    .nullable()
    .optional()
    .describe('Moves the team, with every team under it; null: to the top.'),
});

/**
 * The organization's teams (a tree): what `inMyTeams` conditions read. Put
 * users in teams with `teamIds` on /access/users.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Controller('access/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'Every team, top-level first, with its parent and depth',
  })
  @ApiOkResponse({ standardSchema: listSchema(teamSchema) })
  async list() {
    return { items: await this.teams.list() };
  }

  @Post()
  @Can(AccessPolicy, 'manageTeams')
  @ApiOperation({ summary: 'Create a team' })
  @ApiCreatedResponse({
    standardSchema: teamSchema.omit({ depth: true, members: true }),
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createSchema }) body: z.infer<typeof createSchema>,
    @Ip() ip: string,
  ) {
    return this.teams.create(user, body, ip);
  }

  @Patch(':id')
  @Can(AccessPolicy, 'manageTeams')
  @ApiOperation({
    summary: 'Rename a team, or move it with everything under it',
  })
  @ApiOkResponse({
    standardSchema: teamSchema.omit({ depth: true, members: true }),
  })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>,
    @Ip() ip: string,
  ) {
    return this.teams.update(user, id, body, ip);
  }

  @Delete(':id')
  @Can(AccessPolicy, 'manageTeams')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty team' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: 'It still has teams under it, or members.',
  })
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.teams.remove(user, id, ip);
  }
}
