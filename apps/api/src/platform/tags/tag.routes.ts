import { Body, Ip, Param, ParseUUIDPipe, Put, type Type } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
} from '../records/record-routes.js';
import {
  type SetTagsDto,
  setTagsSchema,
  tagRefListSchema,
} from './tag.schemas.js';
import { TagsService } from './tags.service.js';

/**
 * `PUT /<path>/{id}/tags`: a record's tags. Whoever may change the record
 * sets them (TagsService asks the feature's TagTarget); the tags themselves
 * are managed at /v1/tags.
 */
export function tagRoutes(spec: RecordRouteSpec): Type {
  const { subject, noun } = spec;

  @RecordController(spec, `${spec.path}/:id/tags`)
  class TagRoutes {
    constructor(private readonly tags: TagsService) {}

    @Put()
    @Can.Anyone() // Checked by TagsService: changing the record.
    @ApiOperation({
      summary: `Set ${aNounOf(spec)}'s tags`,
      description: `Replaces the whole set (\`[]\` removes every tag); the tags must be \`${subject}\` tags (GET /v1/tags?subject=${subject}). Answers the ${noun}'s tags, by name. Audited (\`tags.changed\`, from → to).`,
    })
    @ApiOkResponse({ standardSchema: tagRefListSchema })
    @ApiBadRequestResponse({
      description: `An id that is not a ${subject} tag, named by its path (validation_failed).`,
    })
    @ApiForbiddenResponse({ description: `You may not change the ${noun}.` })
    @ApiNotFoundResponse({ description: `No such ${noun}.` })
    async set(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: setTagsSchema }) dto: SetTagsDto,
      @Ip() ip: string,
    ) {
      return {
        items: await this.tags.setTags(
          user,
          { subject, recordId: id },
          dto.tagIds,
          ip,
        ),
      };
    }
  }
  return namedController(TagRoutes, `${spec.className}TagsController`);
}
