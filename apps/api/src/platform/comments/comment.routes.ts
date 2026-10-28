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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { ApiListQuery } from '../../core/http/list-docs.js';
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
  commentCreateSchema,
  type CommentCreateDto,
  commentPageSchema,
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
        "Cursor pages, replies included (each has `parentId`); `?sort=-createdAt` for newest first, `?author=user:<id>`, `?createdAt.gte=`, `?parentId=<comment id>` (one thread's replies) or `?parentId.isNull=true` (the threads), `?resolvedAt.isNull=true` (open) or `=false` (resolved).",
    })
    @ApiOkResponse({ standardSchema: commentPageSchema })
    @ApiListQuery(COMMENT_LIST)
    async list(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query() raw: Record<string, unknown>,
    ) {
      const query = COMMENT_LIST.parse(raw);
      return COMMENT_LIST.pick(
        await this.comments.list(user, record(id), query),
        query,
      );
    }

    @Post()
    @Can.Anyone()
    @ApiOperation({
      summary: `Comment on ${aNounOf(spec)}`,
      description: `Mention people with \`@<email>\` or \`@user:<id>\`: those who may read the ${noun} are told (\`comment.mentioned\`); the ${noun}'s watchers hear \`${noun}.commented\`. Your first comment on ${aNounOf(spec)} makes you watch it. \`parentId\` answers a top-level comment (one level of replies; its author is told, \`comment.replied\`). Audited.`,
    })
    @ApiCreatedResponse({ standardSchema: commentSchema })
    @ApiBadRequestResponse({
      description:
        'An empty body, or longer than 10 000 characters; or `parentId` is itself a reply (comment_reply_too_deep).',
    })
    @ApiConflictResponse({
      description:
        'The thread is resolved (comment_thread_resolved) or holds 200 replies (comment_thread_full).',
    })
    async add(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: commentCreateSchema }) dto: CommentCreateDto,
      @Ip() ip: string,
    ) {
      return this.comments.add(user, record(id), dto.body, ip, dto.parentId);
    }

    @Post(':commentId/resolve')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone()
    @ApiOperation({
      summary: 'Resolve a thread',
      description: `The thread's author, or whoever may change the ${noun} (\`${subject}.update\`). Sets \`resolvedAt\`/\`resolvedBy\` on the top-level comment; repeating it changes nothing. Audited (\`comment.resolved\`).`,
    })
    @ApiOkResponse({ standardSchema: commentSchema })
    @ApiBadRequestResponse({
      description: 'A reply, not a thread (comment_not_thread).',
    })
    resolve(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('commentId', ParseUUIDPipe) commentId: string,
      @Ip() ip: string,
    ) {
      return this.comments.resolve(user, record(id), commentId, ip);
    }

    @Post(':commentId/reopen')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone()
    @ApiOperation({
      summary: 'Reopen a resolved thread',
      description: `As resolving it. Audited (\`comment.reopened\`).`,
    })
    @ApiOkResponse({ standardSchema: commentSchema })
    @ApiBadRequestResponse({
      description: 'A reply, not a thread (comment_not_thread).',
    })
    reopen(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('commentId', ParseUUIDPipe) commentId: string,
      @Ip() ip: string,
    ) {
      return this.comments.reopen(user, record(id), commentId, ip);
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
      description: `Its author, or whoever may change the ${noun} (\`${subject}.update\`). For good; audited. Removing a thread's top-level comment removes its replies too.`,
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
