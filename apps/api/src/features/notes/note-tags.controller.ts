import {
  Body,
  Controller,
  Ip,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { listSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type SetTagsDto,
  setTagsSchema,
  tagRefSchema,
} from '../../platform/tags/tag.schemas.js';
import { TagsService } from '../../platform/tags/tags.service.js';

/**
 * A note's tags (platform/tags): whoever may change the note sets them
 * (NoteTags asks NotePolicy). The tags themselves are managed at /v1/tags.
 */
@ApiTags('notes')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('notes/:id/tags')
export class NoteTagsController {
  constructor(private readonly tags: TagsService) {}

  @Put()
  @Can.Anyone() // Checked by TagsService: changing the note.
  @ApiOperation({
    summary: "Set a note's tags",
    description:
      "Replaces the whole set (`[]` removes every tag); the tags must be `Note` tags (GET /v1/tags?subject=Note). Answers the note's tags, by name. Audited (`tags.changed`, from → to).",
  })
  @ApiOkResponse({ standardSchema: listSchema(tagRefSchema) })
  @ApiBadRequestResponse({
    description:
      'An id that is not a Note tag, named by its path (validation_failed).',
  })
  @ApiForbiddenResponse({ description: 'You may not change the note.' })
  @ApiNotFoundResponse({ description: 'No such note.' })
  async set(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: setTagsSchema }) dto: SetTagsDto,
    @Ip() ip: string,
  ) {
    return {
      items: await this.tags.setTags(
        user,
        { subject: 'Note', recordId: id },
        dto.tagIds,
        ip,
      ),
    };
  }
}
