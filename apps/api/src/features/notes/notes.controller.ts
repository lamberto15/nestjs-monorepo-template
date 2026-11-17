import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
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
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  assertUnchanged,
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../core/http/etag.js';
import { ApiListQuery } from '../../core/http/list-docs.js';
import { pageSchema } from '../../core/http/pagination.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { recordListDocs, sentFields } from '../../platform/records/record.js';
import {
  IncludePipe,
  includeQuery,
  type RecordInclude,
} from '../../platform/records/record-can.js';
import { RecordPresenter } from '../../platform/records/record-contract.js';
import { RecordIdempotent } from '../../platform/records/record-idempotency.js';
import { deleteDocs } from '../../platform/records/record-restore.routes.js';
import { NOTE_LIST } from './note.list.js';
import { NotePolicy } from './note.policy.js';
import { NOTE } from './note.record.js';
import {
  type CreateNoteDto,
  type Note,
  NOTE_SCHEMAS,
  type UpdateNoteDto,
} from './note.schemas.js';
import {
  weeklyNoteCountsQuerySchema,
  weeklyNoteCountsSchema,
  type WeeklyNoteCountsQuery,
} from './note-weekly-counts.js';
import { NotesService } from './notes.service.js';

const SCHEMAS = NOTE_SCHEMAS;

/**
 * Notes: the HTTP routes, nothing else (notes.service.ts does the work).
 * The recycle bin's restore route and the capabilities' routes (tags, comments…) come
 * from note.record.ts (notes.module.ts).
 */
@ApiTags('notes')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('notes')
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly presenter: RecordPresenter,
  ) {}

  @Post()
  // The ETag GET /{id} would send: If-Match on the next write needs no read first.
  @Etag()
  // A retry with the same key gets the first answer instead of a second record (note.record.ts `idempotency`: required, optional or off; unset follows IDEMPOTENCY).
  @RecordIdempotent(NOTE)
  @Can(NotePolicy, 'create')
  @ApiOperation({
    summary: 'Create a note',
    description:
      'Send a new Idempotency-Key per record and the same one on every retry. Audited.',
  })
  @ApiCreatedResponse({ standardSchema: SCHEMAS.response })
  @ApiBadRequestResponse({
    description:
      'The body fails the schema, or the Idempotency-Key is missing.',
  })
  @ApiConflictResponse({
    description: 'A request with this Idempotency-Key is still running.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'This Idempotency-Key was used for a different request.',
  })
  async create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: SCHEMAS.create }) dto: CreateNoteDto,
  ) {
    await this.assertFields(user, 'create', dto);
    return this.presenter.one(user, await this.notes.create(user, dto));
  }

  /** Only those the caller may read: filtered in the query, not after. */
  @Get()
  @Etag()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The notes you may read, newest first',
    description:
      'Filter flat or with `filter`, sort with `sort`, pick fields with `fields`; each parameter lists what it takes. A field your permissions hide is a 403 (field_forbidden).',
  })
  @ApiOkResponse({ standardSchema: pageSchema(SCHEMAS.response) })
  @ApiListQuery(NOTE_LIST, recordListDocs(NOTE))
  @ApiQuery(includeQuery())
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query() raw: Record<string, unknown>,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    // Validated against the custom fields defined now (custom), and no filter, search, sort or `fields` on what the caller may not read.
    const { list, query } = await this.presenter.query(user, NOTE_LIST, raw);
    // The service composes the read filter (the recycle bin is for those who may restore) and the query's filters.
    const page = await this.notes.findPage(user, list, query);
    // Shown as the caller may see them, then `fields`, then with ?include=can each one's `can`.
    return this.presenter.page(user, page, { list, query, include });
  }

  @Get('dashboard/weekly-counts')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Count visible notes by UTC week for the dashboard',
    description:
      'Returns 1–12 Monday-starting weeks in one aggregate query. Only live notes the caller may read are counted.',
  })
  @ApiOkResponse({ standardSchema: weeklyNoteCountsSchema })
  @ApiBadRequestResponse({
    description: '`from` must be a Monday in UTC; `weeks` must be 1–12.',
  })
  async weeklyCounts(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: weeklyNoteCountsQuerySchema })
    query: WeeklyNoteCountsQuery,
  ) {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    if (from.getUTCDay() !== 1) {
      throw new BadRequestException('from must be a Monday in UTC.');
    }
    return this.notes.weeklyCounts(user, from, query.weeks);
  }

  @Get(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the record itself.
  @ApiOperation({
    summary: 'One note',
    description:
      'With an ETag: If-None-Match gets 304 while unchanged; If-Match on a write refuses it if it changed.',
  })
  @ApiHeader(ifNoneMatchHeader())
  @ApiQuery(includeQuery())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  async get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    // One the caller may not read: the same 404 as a missing one.
    const row = await this.notes.findOne(id, undefined, { visibleTo: user });
    await this.authorization.authorize(NotePolicy, 'read', user, row);
    return this.presenter.one(user, row, include);
  }

  @Patch(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the record and on each field.
  @ApiOperation({
    summary: 'Change a note: only what is sent changes',
    description:
      'With If-Match, refused (412) if it changed since you read it. Audited with what changed.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: SCHEMAS.response })
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  async update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: SCHEMAS.update }) dto: UpdateNoteDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    // Unreadable: a 404; readable but not theirs to change: a 403 (below).
    const row = await this.notes.findOne(id, undefined, { visibleTo: user });
    return this.presenter.one(
      user,
      await this.notes.update(user, row, dto, ip, {
        assertCurrent: async (current) => {
          await this.authorization.authorize(
            NotePolicy,
            'update',
            user,
            current,
          );
          assertUnchanged(ifMatch, await this.presenter.one(user, current));
          await this.assertFields(user, 'update', dto, current);
        },
      }),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone() // Checked below, on the record itself.
  @ApiOperation(deleteDocs(NOTE))
  @ApiHeader(ifMatchHeader())
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  async delete(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    // Unreadable: a 404; readable but not theirs to delete: a 403 (below).
    const row = await this.notes.findOne(id, undefined, { visibleTo: user });
    await this.notes.delete(user, row, ip, async (current) => {
      await this.authorization.authorize(NotePolicy, 'delete', user, current);
      assertUnchanged(ifMatch, await this.presenter.one(user, current));
    });
  }

  /** Field-level: a 403 naming the fields this caller may not set. */
  private async assertFields(
    user: RequestPrincipal,
    action: string,
    dto: object,
    row?: Note,
  ) {
    const forbidden = await this.access.forbiddenFields(
      user,
      action,
      'Note',
      sentFields(dto),
      row,
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not set: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
  }
}
