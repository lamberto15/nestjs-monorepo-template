import {
  Body,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
} from '../records/record-routes.js';
import {
  duplicateListSchema,
  type FindDuplicatesDto,
  findDuplicatesSchema,
  type MergeDto,
  mergePreviewSchema,
  mergeSchema,
} from './merge.schemas.js';
import { MERGES, type Merges } from './record-merge.js';

/**
 * A record's duplicates and their merge (the `merge` capability,
 * docs/merging.md): `POST /<path>/duplicates` (values not saved yet),
 * `GET /<path>/{id}/duplicates`, `POST /<path>/{id}/merge/preview` and
 * `POST /<path>/{id}/merge`. Checked by its merges (MERGES: RecordMerge, or the feature's own): reading finds only
 * records the caller may read, merging takes changing the survivor and
 * deleting the duplicate.
 */
export function mergeRoutes(
  declaration: RecordRouteSpec,
  options: { response: z.ZodType },
): Type {
  const { noun, path } = declaration;
  const nouns = path.replace(/-/g, ' ');

  @ApiNotFoundResponse({ description: `No such ${noun} that you may read.` })
  @RecordController(declaration, path)
  class MergeRoutes {
    constructor(@Inject(MERGES) private readonly merges: Merges) {}

    @Post('duplicates')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone() // Only records the caller may read are searched.
    @ApiOperation({
      summary: `Find ${nouns} like these values`,
      description: `Before creating or changing ${aNounOf(declaration)}: the ${nouns} you may read that its values would duplicate, by the feature's rules (each rule's fields all equal; text without case or surrounding spaces), newest first, at most 20. A match by a field you may not read on a record is no match.`,
    })
    @ApiOkResponse({ standardSchema: duplicateListSchema })
    find(
      @CurrentUser() user: RequestPrincipal,
      @Body({ schema: findDuplicatesSchema }) dto: FindDuplicatesDto,
    ) {
      return this.merges.find(user, dto);
    }

    @Get(':id/duplicates')
    @Can.Anyone()
    @ApiOperation({
      summary: `The likely duplicates of ${aNounOf(declaration)}`,
      description: `The other ${nouns} you may read matching it by the feature's rules, by its values you may read.`,
    })
    @ApiOkResponse({ standardSchema: duplicateListSchema })
    duplicates(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
    ) {
      return this.merges.duplicatesOf(user, id);
    }

    @Post(':id/merge/preview')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone()
    @ApiOperation({
      summary: `Preview merging a duplicate into ${aNounOf(declaration)}`,
      description:
        'What the merge would do, checked as it checks: the fields you may choose (read on both, change on the survivor), each with both values and whose is kept, the survivor as it would be, and what moves to it. Changes nothing.',
    })
    @ApiOkResponse({ standardSchema: mergePreviewSchema })
    @ApiForbiddenResponse({
      description:
        'You may not change the survivor, delete the duplicate, choose a field (field_forbidden) or change a record referring to the duplicate (merge_references_forbidden).',
    })
    @ApiConflictResponse({
      description: 'The duplicate is under a legal hold (legal_hold).',
    })
    @ApiUnprocessableEntityResponse({
      description:
        'The same record twice (merge_same_record), or the survivor would refer to itself (merge_self_reference).',
    })
    preview(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: mergeSchema }) dto: MergeDto,
    ) {
      return this.merges.preview(user, id, dto);
    }

    @Post(':id/merge')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone()
    @ApiOperation({
      summary: `Merge a duplicate into ${aNounOf(declaration)}`,
      description: `In one transaction, or not at all: the survivor takes the values \`fields\` chooses from the duplicate (audited \`${declaration.subject[0]!.toLowerCase()}${declaration.subject.slice(1)}.updated\`, a revision), gains its tags, comments, attachments and watchers, the records referring to it point at the survivor, and the duplicate goes to the recycle bin (restorable: POST /v1/${path}/{id}/restore). Audited \`.merged\` with what moved. The checks are the preview's. Answers the survivor.`,
    })
    @ApiOkResponse({ standardSchema: options.response })
    @ApiForbiddenResponse({
      description:
        'As the preview: the survivor, the duplicate, a field or a referring record.',
    })
    @ApiConflictResponse({
      description:
        'A legal hold, an approval pending on either record, or a unique value another record holds.',
    })
    @ApiUnprocessableEntityResponse({
      description: 'As the preview.',
    })
    merge(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: mergeSchema }) dto: MergeDto,
      @Ip() ip: string,
    ) {
      return this.merges.merge(user, id, dto, ip);
    }
  }
  return namedController(
    MergeRoutes,
    `${declaration.className}MergeController`,
  );
}
