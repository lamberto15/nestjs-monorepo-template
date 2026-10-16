import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import { TAG_LIST } from './tag.list.js';
import {
  type CreateTagDto,
  createTagSchema,
  tagSchema,
  type UpdateTagDto,
  updateTagSchema,
} from './tag.schemas.js';
import { TagsService } from './tags.service.js';

/**
 * The tags records may carry. Anyone signed in reads them (to show and
 * pick them); creating, changing and deleting takes Access.manageTags.
 * A record's tags are set on the record's own route
 * (`PUT /notes/{id}/tags`), which checks the record's permission.
 */
@ApiTags('tags')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The tags, newest first',
    description:
      'Every subject unless `?subject=Note` (or `subject.in=`); `?name.contains=urg`, `?name=Urgent` (whatever the case); `?sort=name`. Cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(tagSchema) })
  async list(@Query({ schema: TAG_LIST.schema }) query: ListQuery) {
    return TAG_LIST.pick(await this.tags.list(query), query);
  }

  @Post()
  @Can(AccessPolicy, 'manageTags')
  @ApiOperation({
    summary: 'Create a tag',
    description:
      'For a subject whose records take tags (`Note`); the name is unique per subject, whatever its case. Audited (`tag.created`).',
  })
  @ApiCreatedResponse({ standardSchema: tagSchema })
  @ApiBadRequestResponse({
    description:
      'A subject that takes no tags, a colour that is not #rrggbb, a name too long (validation_failed).',
  })
  @ApiConflictResponse({ description: 'The subject has a tag of this name.' })
  create(
    @CurrentUser() user: Principal,
    @Body({ schema: createTagSchema }) dto: CreateTagDto,
    @Ip() ip: string,
  ) {
    return this.tags.create(user, dto, ip);
  }

  @Patch(':id')
  @Can(AccessPolicy, 'manageTags')
  @ApiOperation({
    summary: 'Rename, recolour or describe a tag',
    description:
      'Only what is sent changes; null clears the colour or the description. Audited (`tag.updated`).',
  })
  @ApiOkResponse({ standardSchema: tagSchema })
  @ApiBadRequestResponse({
    description: 'An invalid body (validation_failed).',
  })
  @ApiConflictResponse({ description: 'The subject has a tag of this name.' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateTagSchema }) dto: UpdateTagDto,
    @Ip() ip: string,
  ) {
    return this.tags.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AccessPolicy, 'manageTags')
  @ApiOperation({
    summary: 'Delete a tag',
    description: 'Every record carrying it loses it. Audited (`tag.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.tags.remove(user, id, ip);
  }
}
