import {
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
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import { Idempotent } from '@nestjs/idempotency';
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
  ApiPreconditionFailedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AccessService } from '../../iam/access/access.service.js';
import { NotePolicy } from './note.policy.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { idempotencyKeyHeader } from '../../platform/idempotency/idempotency.openapi.js';
import {
  assertUnchanged,
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../core/http/etag.js';
import { principalScope } from '../../platform/idempotency/idempotency.scopes.js';
import {
  createNoteSchema,
  noteSchema,
  noteView,
  type CreateNoteDto,
  type Note,
  updateNoteSchema,
  type UpdateNoteDto,
} from './note.schemas.js';
import {
  IncludePipe,
  includeQuery,
  recordCan,
  recordCanActions,
  type RecordInclude,
  withCan,
} from '../../platform/records/record-can.js';
import { NotesService } from './notes.service.js';
import { pageSchema } from '../../core/http/pagination.js';
import { ApiListQuery } from '../../core/http/list-docs.js';
import { CustomFieldsService } from '../../platform/custom-fields/custom-fields.service.js';
import { and } from 'drizzle-orm';
import { NOTE_LIST } from './note.list.js';

/**
 * The example feature's API, for API clients (a key) and users (a session).
 * It shows the three ways a permission is checked: on the route (create),
 * on the loaded record (read, delete), and in the query (list).
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
    private readonly customFields: CustomFieldsService,
  ) {}

  @Post()
  // The ETag GET /notes/{id} would send: If-Match on the next write needs no read first.
  @Etag()
  // A retry with the same key gets the first note back instead of a second note.
  @Idempotent({ scope: principalScope })
  @Can(NotePolicy, 'create')
  @ApiOperation({
    summary: 'Write a note',
    description:
      'Saves a draft, starts its publication workflow and sends note.created, in one transaction. Send a new Idempotency-Key per note and the same one on every retry. With the ETag GET /v1/notes/{id} would send: use it as If-Match on the next write.',
  })
  @ApiHeader(idempotencyKeyHeader(true))
  @ApiCreatedResponse({ standardSchema: noteSchema })
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
    @Body({ schema: createNoteSchema }) dto: CreateNoteDto,
  ) {
    // An empty text (or no custom value) sets nothing: only a real value needs the field's permission.
    await this.assertFields(user, 'create', {
      ...dto,
      body: dto.body || undefined,
      custom:
        dto.custom && Object.keys(dto.custom).length ? dto.custom : undefined,
    });
    return this.shown(user, await this.notes.create(user, dto));
  }

  /** Field-level: a 403 naming the fields this caller may not set. */
  private async assertFields(
    user: RequestPrincipal,
    action: string,
    dto: Record<string, unknown>,
    note?: Note,
  ) {
    const forbidden = await this.access.forbiddenFields(
      user,
      action,
      'Note',
      dto,
      note,
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not set: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
  }

  /** Only the notes the caller may read: filtered in the query, not after. */
  @Get()
  @Etag()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The notes you may read, newest first',
    description:
      'Filter flat (`?status=draft&title.contains=report`) or with `filter` (and/or groups), sort with `sort=-createdAt,title`, pick fields with `fields=title,status`; each parameter lists what it takes. Only the notes you may read, whatever the filter. Filtering, searching, sorting or picking by a field your permissions hide (the text, the custom fields) is a 403 (field_forbidden).',
  })
  @ApiOkResponse({ standardSchema: pageSchema(noteSchema) })
  @ApiListQuery(
    NOTE_LIST,
    'Custom fields (GET /v1/custom-fields?subject=Note) filter, sort and select like the fields above: `custom.region=eu`, `custom.amount.gte=10`, in `filter` and `sort` as `custom.<key>`, `fields=custom.region`.',
  )
  @ApiQuery(includeQuery())
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query() raw: Record<string, unknown>,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    // The list with the custom fields defined now: validated per request.
    const list = await this.customFields.extendList(NOTE_LIST, 'Note');
    // `include` is no filter: read above.
    const { include: _include, ...filters } = raw;
    const query = list.parse(filters);
    // Field-level: no filter, search, sort or `fields` on what the caller may not read.
    // Matched among the rows the list reaches: the recycle bin's are those the caller may restore.
    await this.access.assertQueryFields(user, 'Note', query, {
      reach: query.deleted ? 'restore' : 'read',
    });
    const page = await this.notes.findPage(
      and(
        // The recycle bin (?deleted=true) is for those who may restore.
        await this.access.sqlFilter(
          user,
          'Note',
          query.deleted ? 'restore' : 'read',
          { deleted: query.deleted === true },
        ),
        list.where(query),
      ),
      query,
      list.sortSelect(query),
    );
    // Field-level: the text only for those whose permissions include it.
    // Then `fields`: after redaction, so what it hid stays hidden.
    const picked = list.pick(
      {
        ...page,
        items: await this.access.redactAll(
          user,
          'read',
          'Note',
          await this.customFields.visible(
            'Note',
            await this.notes.withTags(page.items.map(noteView)),
          ),
        ),
      },
      query,
    );
    if (!include.can) {
      return picked;
    }
    // Each note's `can`, from the stored rows (whatever `fields` picked).
    const can = await this.can(user, page.items);
    return {
      ...picked,
      items: picked.items.map((item) => withCan(item, can)),
    };
  }

  @Get(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the note itself.
  @ApiOperation({
    summary: 'One note',
    description:
      'With an ETag: send it back as If-None-Match to get 304 while unchanged, or as If-Match on a write to be refused if it changed.',
  })
  @ApiHeader(ifNoneMatchHeader())
  @ApiQuery(includeQuery())
  @ApiOkResponse({ standardSchema: noteSchema })
  @ApiNotFoundResponse()
  async get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    const note = await this.notes.findOne(id);
    await this.authorization.authorize(NotePolicy, 'read', user, note);
    const shown = await this.shown(user, note);
    return include.can ? withCan(shown, await this.can(user, [note])) : shown;
  }

  @Patch(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the note and on each field.
  @ApiOperation({
    summary: 'Change a note: only what is sent changes',
    description:
      'Your own drafts. Changing the text takes a permission that includes it. With If-Match, refused (412) if the note changed since you read it. Audited with what changed.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: noteSchema })
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'The note changed since you read it (precondition_failed).',
  })
  async update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateNoteSchema }) dto: UpdateNoteDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    const note = await this.notes.findOne(id);
    await this.authorization.authorize(NotePolicy, 'update', user, note);
    assertUnchanged(ifMatch, await this.shown(user, note));
    const forbidden = await this.access.forbiddenFields(
      user,
      'update',
      'Note',
      dto,
      note,
    );
    if (forbidden.length) {
      throw new ForbiddenException({
        code: 'field_forbidden',
        message: `You may not change: ${forbidden.join(', ')}.`,
        fields: forbidden,
      });
    }
    const updated = await this.notes.update(user, note, dto, ip);
    return this.shown(user, updated);
  }

  @Post(':id/restore')
  @Etag()
  @Can.Anyone() // Checked below, on the note itself.
  @ApiOperation({
    summary: 'Restore a note from the recycle bin',
    description:
      'Until the purge (SOFT_DELETE_RETENTION_DAYS after deleting it).',
  })
  @ApiOkResponse({ standardSchema: noteSchema })
  @ApiNotFoundResponse({ description: 'Not in the recycle bin (or purged).' })
  async restore(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    const note = await this.notes.findOne(id, undefined, { deleted: true });
    await this.authorization.authorize(NotePolicy, 'restore', user, note);
    return this.shown(user, await this.notes.restore(user, note, ip));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone() // Checked below, on the note itself.
  @ApiOperation({
    summary: 'Delete a note (to the recycle bin)',
    description:
      'It disappears from every list; POST /v1/notes/{id}/restore brings it back until it is purged.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiPreconditionFailedResponse({
    description: 'The note changed since you read it (precondition_failed).',
  })
  async delete(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    const note = await this.notes.findOne(id);
    await this.authorization.authorize(NotePolicy, 'delete', user, note);
    assertUnchanged(ifMatch, await this.shown(user, note));
    await this.notes.delete(user, note, ip);
  }

  /** A note as this caller reads it: its tags and active custom fields, less the fields they may not see (what the ETag covers). */
  private async shown(user: RequestPrincipal, note: Note) {
    const [shown] = await this.customFields.visible(
      'Note',
      await this.notes.withTags([noteView(note)]),
    );
    return this.access.redact(user, 'read', 'Note', shown!);
  }

  /** Each note's `can` (?include=can), by id: NotePolicy's checks, as the routes make them. */
  private can(user: RequestPrincipal, notes: Note[]) {
    return recordCan(
      this.authorization,
      NotePolicy,
      user,
      notes,
      recordCanActions(true),
    );
  }
}
