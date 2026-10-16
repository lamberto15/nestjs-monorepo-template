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
import { ApiListQuery } from '../../core/http/list-docs.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { COMMENT_LIST } from '../../platform/comments/comment.list.js';
import {
  commentBodySchema,
  type CommentBodyDto,
  commentSchema,
} from '../../platform/comments/comment.schemas.js';
import { CommentsService } from '../../platform/comments/comments.service.js';

const note = (recordId: string) => ({ subject: 'Note', recordId });

/**
 * A note's comments (platform/comments): whoever may read the note reads
 * and writes them (NoteComments asks NotePolicy); `@<email>` mentions a
 * person who may read it too.
 */
@ApiTags('notes')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'You may not read the note.' })
@ApiNotFoundResponse({ description: 'No such note (or comment).' })
@Controller('notes/:id/comments')
export class NoteCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  @Can.Anyone() // Checked by CommentsService: reading the note.
  @ApiOperation({
    summary: "A note's comments, oldest first",
    description:
      'Cursor pages; `?sort=-createdAt` for newest first, `?author=user:<id>`, `?createdAt.gte=`.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(commentSchema) })
  @ApiListQuery(COMMENT_LIST)
  async list(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() raw: Record<string, unknown>,
  ) {
    const query = COMMENT_LIST.parse(raw);
    return COMMENT_LIST.pick(
      await this.comments.list(user, note(id), query),
      query,
    );
  }

  @Post()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Comment on a note',
    description:
      "Mention people with `@<email>` or `@user:<id>`: those who may read the note are told (`comment.mentioned`); the note's watchers hear `note.commented`. Your first comment on a note makes you watch it. Audited.",
  })
  @ApiCreatedResponse({ standardSchema: commentSchema })
  @ApiBadRequestResponse({
    description: 'An empty body, or longer than 10 000 characters.',
  })
  async add(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: commentBodySchema }) dto: CommentBodyDto,
    @Ip() ip: string,
  ) {
    return this.comments.add(user, note(id), dto.body, ip);
  }

  @Patch(':commentId')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Change your comment',
    description:
      'Only its author; sets `editedAt`. People newly mentioned are told. Audited.',
  })
  @ApiOkResponse({ standardSchema: commentSchema })
  @ApiBadRequestResponse({
    description: 'An empty body, or longer than 10 000 characters.',
  })
  async edit(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body({ schema: commentBodySchema }) dto: CommentBodyDto,
    @Ip() ip: string,
  ) {
    return this.comments.edit(user, note(id), commentId, dto.body, ip);
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({
    summary: 'Remove a comment',
    description:
      'Its author, or whoever may change the note (`Note.update`). For good; audited.',
  })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Ip() ip: string,
  ) {
    await this.comments.remove(user, note(id), commentId, ip);
  }
}
