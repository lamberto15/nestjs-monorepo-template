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
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { VIEW_LIST } from './view.list.js';
import {
  type CreateViewDto,
  createViewSchema,
  type UpdateViewDto,
  updateViewSchema,
  viewAppliedSchema,
  viewPageSchema,
  viewSchema,
} from './view.schemas.js';
import { ViewsService } from './views.service.js';

const VALIDATION =
  'An unknown list (`subject`), a query the list refuses (`query.<parameter>`: paging, `fields`, `deleted` and `lang` are not filters), a column not in its `select` (`columns`), a team that does not exist, more than 100 views (validation_failed).';
const FIELD_FORBIDDEN =
  'Its query filters, searches or sorts by a field your permissions hide (field_forbidden, naming it).';

/**
 * Saved views: a list's filters, sort and columns under a name, for every
 * list `GET /v1/lists/{subject}` describes. Private to their owner, shared
 * with a team, or tenant-wide (`Access.manageViews`). Anyone signed in
 * keeps their own; what a view shows is checked against the viewer's own
 * permissions when it is applied.
 */
@ApiTags('views')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // A view is its owner's or shared; the list's own read permission is checked.
@Controller('views')
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  @ApiOperation({
    summary: 'The saved views you see',
    description:
      'Yours, those shared with your teams and the tenant-wide ones, of the lists you may read. `?subject=Note`, `?visibility=team`, `?name.contains=`, `?sort=name`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: viewPageSchema })
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: VIEW_LIST.schema }) query: ListQuery,
  ) {
    return VIEW_LIST.pick(await this.views.page(user, query), query);
  }

  @Post()
  @ApiOperation({
    summary: 'Save a view of a list',
    description:
      "The list's filters, sort and search as its route takes them (`query`) and the item fields to show (`columns`), validated against the list as it is now (custom fields included). `visibility`: `private` (default), `team` (with `teamId`: a team you belong to) or `tenant` (`Access.manageViews`). The name is unique per list and place, whatever its case. Audited (`view.created`).",
  })
  @ApiCreatedResponse({ standardSchema: viewSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({
    description: `You may not read the list; not allowed to share it so; ${FIELD_FORBIDDEN}`,
  })
  @ApiConflictResponse({ description: 'The name is taken (conflict).' })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: createViewSchema }) dto: CreateViewDto,
    @Ip() ip: string,
  ) {
    return this.views.create(user, dto, ip);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One saved view you see' })
  @ApiOkResponse({ standardSchema: viewSchema })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.views.get(user, id);
  }

  @Get(':id/apply')
  @ApiOperation({
    summary: 'A saved view, ready to use',
    description:
      "The view checked again against the list as it is now and your permissions: `params` is the query to send to the subject's list route (its filters and sort, and `fields=` for the columns), `columns` the ones you may see, `hiddenColumns` those left out.",
  })
  @ApiOkResponse({ standardSchema: viewAppliedSchema })
  @ApiBadRequestResponse({
    description:
      'The list changed since the view was saved and refuses its query (validation_failed, `query.<parameter>`).',
  })
  @ApiForbiddenResponse({ description: FIELD_FORBIDDEN })
  @ApiNotFoundResponse()
  apply(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.views.apply(user, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a saved view',
    description:
      'Only what is sent changes (never the list). Its owner changes it; a shared view, a view manager too (`Access.manageViews`). Audited (`view.updated`).',
  })
  @ApiOkResponse({ standardSchema: viewSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({
    description: `Not yours to change or to share so; ${FIELD_FORBIDDEN}`,
  })
  @ApiConflictResponse({ description: 'The name is taken (conflict).' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateViewSchema }) dto: UpdateViewDto,
    @Ip() ip: string,
  ) {
    return this.views.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a saved view',
    description:
      'Its owner; a shared view, a view manager too. Audited (`view.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Not yours to delete.' })
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.views.remove(user, id, ip);
  }
}
