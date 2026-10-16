import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { assertUnchanged, Etag, ifMatchHeader } from '../../core/http/etag.js';
import { ApiListQuery } from '../../core/http/list-docs.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { REVISION_LIST } from '../../platform/revisions/revision.list.js';
import {
  revisionDiffSchema,
  revisionSchema,
} from '../../platform/revisions/revision.schemas.js';
import { RevisionsService } from '../../platform/revisions/revisions.service.js';
import { noteSchema } from './note.schemas.js';

const note = (recordId: string) => ({ subject: 'Note', recordId });

/** A revision number in the path: a positive integer, else 400. */
const revisionNumber = new ParseIntPipe({ errorHttpStatusCode: 400 });

/**
 * A note's revisions (platform/revisions): whoever may read the note reads
 * them (NoteRevisions asks NotePolicy); whoever may change it restores one.
 */
@ApiTags('notes')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiNotFoundResponse({
  description: 'No such note (or you may not read it), or no such revision.',
})
@Controller('notes/:id/revisions')
export class NoteRevisionsController {
  constructor(private readonly revisions: RevisionsService) {}

  @Get()
  @Can.Anyone() // Checked by RevisionsService: reading the note.
  @ApiOperation({
    summary: "A note's revisions, newest first",
    description:
      'Revision 1 is the note as written; each change adds one, with what changed (`changes`, from → to). Cursor pages; `?changedBy=user:<id>`, `?number.gte=`. The text and custom values only when your permissions include them.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(revisionSchema) })
  @ApiListQuery(REVISION_LIST)
  async list(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() raw: Record<string, unknown>,
  ) {
    const query = REVISION_LIST.parse(raw);
    return REVISION_LIST.pick(
      await this.revisions.list(user, note(id), query),
      query,
    );
  }

  @Get(':number')
  @Can.Anyone()
  @ApiOperation({ summary: 'One revision of a note' })
  @ApiOkResponse({ standardSchema: revisionSchema })
  async get(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('number', revisionNumber) number: number,
  ) {
    return this.revisions.get(user, note(id), number);
  }

  @Get(':a/diff/:b')
  @Can.Anyone()
  @ApiOperation({
    summary: 'What differs between two revisions of a note',
    description:
      "From revision `a`'s values to `b`'s (either order); `custom.<key>` per custom value.",
  })
  @ApiOkResponse({ standardSchema: revisionDiffSchema })
  async diff(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('a', revisionNumber) a: number,
    @Param('b', revisionNumber) b: number,
  ) {
    return this.revisions.diff(user, note(id), a, b);
  }

  @Post(':number/restore')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @Can.Anyone() // Checked by RevisionsService: changing the note (Note.update).
  @ApiOperation({
    summary: 'Set a note back to a revision',
    description:
      "Its title, text and custom values become the revision's, as a PATCH would set them (the same permissions, field-level ones too): audited `note.updated`, and a new revision with `restoredFrom`. With If-Match (the note's ETag), refused (412) if the note changed since you read it. Answers the note.",
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: noteSchema })
  @ApiForbiddenResponse({
    description:
      'You may not change the note, or a field it would set (field_forbidden).',
  })
  @ApiPreconditionFailedResponse({
    description: 'The note changed since you read it (precondition_failed).',
  })
  async restore(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('number', revisionNumber) number: number,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.revisions.restore(user, note(id), number, {
      ip,
      unchanged: (current) => assertUnchanged(ifMatch, current),
    });
  }
}
