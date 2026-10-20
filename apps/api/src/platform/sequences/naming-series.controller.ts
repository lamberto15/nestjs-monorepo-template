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
  Put,
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
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import { NAMING_SERIES_LIST } from './naming-series.list.js';
import {
  type CreateNamingSeriesDto,
  createNamingSeriesSchema,
  namingCounterSchema,
  namingSeriesPageSchema,
  namingSeriesSchema,
  numberedSubjectListSchema,
  type PreviewNamingSeriesDto,
  previewNamingSeriesSchema,
  type SetNamingCounterDto,
  setNamingCounterSchema,
  type UpdateNamingSeriesDto,
  updateNamingSeriesSchema,
} from './naming-series.schemas.js';
import { NamingSeriesService } from './naming-series.service.js';

/**
 * Naming series: the number formats of numbered records. Anyone signed in
 * reads them (to pick one when creating a record); creating, changing,
 * deleting them and setting a counter takes Access.manageNamingSeries.
 */
@ApiTags('naming-series')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('naming-series')
export class NamingSeriesController {
  constructor(private readonly series: NamingSeriesService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The naming series, newest first',
    description:
      'Every subject unless `?subject=Note`; `?isDefault=true` for the defaults; `?sort=pattern`. Each with `example`, the number it gives next. Cursor pages.',
  })
  @ApiOkResponse({ standardSchema: namingSeriesPageSchema })
  async list(@Query({ schema: NAMING_SERIES_LIST.schema }) query: ListQuery) {
    return NAMING_SERIES_LIST.pick(await this.series.list(query), query);
  }

  @Get('subjects')
  @Can.Anyone()
  @ApiOperation({
    summary: 'The subjects whose records take a number',
    description:
      'Each with the format it has in code (`declaredPattern`), which numbers it while it has no series.',
  })
  @ApiOkResponse({ standardSchema: numberedSubjectListSchema })
  subjects() {
    return { items: this.series.subjects() };
  }

  @Get('preview')
  @Can(AccessPolicy, 'manageNamingSeries')
  @ApiOperation({
    summary: 'Preview a pattern',
    description:
      'What the pattern would give now, before it is saved: its counter key, the last value taken under that key (shared with any series printing the same), the next number.',
  })
  @ApiOkResponse({ standardSchema: namingCounterSchema })
  @ApiBadRequestResponse({
    description:
      'An invalid pattern, or a subject that takes no number (validation_failed).',
  })
  preview(
    @Query({ schema: previewNamingSeriesSchema }) query: PreviewNamingSeriesDto,
  ) {
    return this.series.preview(query.subject, query.pattern);
  }

  @Get(':id')
  @Can.Anyone()
  @ApiOperation({ summary: 'A naming series' })
  @ApiOkResponse({ standardSchema: namingSeriesSchema })
  @ApiNotFoundResponse()
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.series.findOne(id);
  }

  @Post()
  @Can(AccessPolicy, 'manageNamingSeries')
  @ApiOperation({
    summary: 'Create a naming series',
    description:
      "For a subject whose records take a number (GET /v1/naming-series/subjects). A subject's first series becomes its default, taking over from the format in code; a pattern that prints what that format prints carries on its counter. Audited (`namingSeries.created`).",
  })
  @ApiCreatedResponse({ standardSchema: namingSeriesSchema })
  @ApiBadRequestResponse({
    description:
      'A subject that takes no number, an invalid pattern (validation_failed).',
  })
  @ApiConflictResponse({ description: 'The subject has this pattern.' })
  create(
    @CurrentUser() user: Principal,
    @Body({ schema: createNamingSeriesSchema }) dto: CreateNamingSeriesDto,
    @Ip() ip: string,
  ) {
    return this.series.create(user, dto, ip);
  }

  @Patch(':id')
  @Can(AccessPolicy, 'manageNamingSeries')
  @ApiOperation({
    summary: 'Change a naming series',
    description:
      'Its pattern, its label, or `isDefault: true` to make it the default. Numbers already given stay as they are. Audited (`namingSeries.updated`).',
  })
  @ApiOkResponse({ standardSchema: namingSeriesSchema })
  @ApiBadRequestResponse({
    description: 'An invalid body (validation_failed).',
  })
  @ApiConflictResponse({ description: 'The subject has this pattern.' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateNamingSeriesSchema }) dto: UpdateNamingSeriesDto,
    @Ip() ip: string,
  ) {
    return this.series.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AccessPolicy, 'manageNamingSeries')
  @ApiOperation({
    summary: 'Delete a naming series',
    description:
      'Records keep their numbers, and the counter stays. Deleting the default makes the oldest series left the default (or the format in code, when none is left). Audited (`namingSeries.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.series.remove(user, id, ip);
  }

  @Get(':id/counter')
  @Can.Anyone()
  @ApiOperation({
    summary: "A naming series' counter now",
    description:
      "This period's counter (this year's with `YYYY`, this month's with `MM`): its key, the last value taken, the next number.",
  })
  @ApiOkResponse({ standardSchema: namingCounterSchema })
  @ApiNotFoundResponse()
  counter(@Param('id', ParseUUIDPipe) id: string) {
    return this.series.counterOf(id);
  }

  @Put(':id/counter')
  @Can(AccessPolicy, 'manageNamingSeries')
  @ApiOperation({
    summary: "Set a naming series' counter",
    description:
      "Starts this period's counter at `current`: the next record gets `current + 1` (to continue numbers from another system). Never below the last value taken. Audited (`namingSeries.counterSet`, from → to).",
  })
  @ApiOkResponse({ standardSchema: namingCounterSchema })
  @ApiBadRequestResponse({
    description: 'An invalid body (validation_failed).',
  })
  @ApiConflictResponse({
    description: 'Below the last value taken: that number is given.',
  })
  @ApiNotFoundResponse()
  setCounter(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: setNamingCounterSchema }) dto: SetNamingCounterDto,
    @Ip() ip: string,
  ) {
    return this.series.setCounter(user, id, dto, ip);
  }
}
