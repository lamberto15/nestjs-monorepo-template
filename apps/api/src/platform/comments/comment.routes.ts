import {
  Body,
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
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
} from '../records/record-routes.js';
import { COMMENT_LIST } from './comment.list.js';
import {
  commentBodySchema,
  type CommentBodyDto,
  commentSchema,
} from './comment.schemas.js';
import { CommentsService } from './comments.service.js';

/**
 * `/<path>/{id}/comments`: a record's comments. Whoever may read the record
 * reads and writes them (CommentsService asks the feature's CommentTarget);
 * `@<email>` mentions a person who may read it too.
 */
export function commentRoutes(spec: RecordRouteSpec): Type {
  const { subject, noun } = spec;
  const record = (recordId: string) => ({ subject, recordId });

  @ApiForbiddenResponse({ description: `You may not read the ${noun}.` })
  @ApiNotFoundResponse({ description: `No such ${noun} (or comment).` })
  @RecordController(spec, `${spec.path}/:id/comments`)
  class CommentRoutes {
    constructor(private readonly comments: CommentsService) {}

    @Get()
    @Can.Anyone() // Checked by CommentsService: reading the record.
    @ApiOperation({
      summary: `${aNounOf(spec).replace(/^a/, 'A')}'s comments, oldest first`,
      description:
        'Cursor pages; `?sort=-createdAt` for newest first, `?author=user:<id>`, `?createdAt.gte=`.',
    })
    @ApiOkResponse({ standardSchema: pageSchema(commentSchema) })
    async list(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      // Validated and documented by the list's schema, as attachments' (its types: `limit` a number).
      @Query({ schema: COMMENT_LIST.schema }) query: ListQuery,
    ) {
      return COMMENT_LIST.pick(
        await this.comments.list(user, record(id), query),
        query,
      );
    }

    @Post()
    @Can.Anyone()
    @ApiOperation({
      summary: `Comment on ${aNounOf(spec)}`,
      description: `Mention people with \`@<email>\` or \`@user:<id>\`: those who may read the ${noun} are told (\`comment.mentioned\`); the ${noun}'s watchers hear \`${noun}.commented\`. Your first comment on ${aNounOf(spec)} makes you watch it. Audited.`,
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
      return this.comments.add(user, record(id), dto.body, ip);
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
      return this.comments.edit(user, record(id), commentId, dto.body, ip);
    }

    @Delete(':commentId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone()
    @ApiOperation({
      summary: 'Remove a comment',
      description: `Its author, or whoever may change the ${noun} (\`${subject}.update\`). For good; audited.`,
    })
    @ApiNoContentResponse()
    async remove(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('commentId', ParseUUIDPipe) commentId: string,
      @Ip() ip: string,
    ) {
      await this.comments.remove(user, record(id), commentId, ip);
    }
  }
  return namedController(CommentRoutes, `${spec.className}CommentsController`);
}
