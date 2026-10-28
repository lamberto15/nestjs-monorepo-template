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
import { pageSchema } from '../../core/http/pagination.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { RECORD_SCHEDULE_LIST } from './record-schedule.list.js';
import {
  type CreateRecordScheduleDto,
  createRecordScheduleSchema,
  type PreviewRecordScheduleDto,
  previewRecordScheduleSchema,
  previewSchema,
  recordScheduleSchema,
  type UpdateRecordScheduleDto,
  updateRecordScheduleSchema,
} from './record-schedule.schemas.js';
import { RecordSchedulesService } from './record-schedules.service.js';

const VALIDATION =
  'An import you may not run (`importer`), a template it refuses (`template.<field>`), a bad rule, time zone or calendar, no occurrence to come, more than 20 active schedules (validation_failed).';

/**
 * Recurring record schedules: a record created for you at every occurrence
 * of a rule. Users and API clients each see and change only their own
 * (another's is a 404); what may be created is what `GET /v1/data` lists
 * as an import for the caller.
 */
@ApiTags('record-schedules')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each schedule is its owner's; the import's own permission is checked.
@Controller('record-schedules')
export class RecordSchedulesController {
  constructor(private readonly schedules: RecordSchedulesService) {}

  @Get()
  @ApiOperation({
    summary: 'Your recurring record schedules',
    description:
      '`?status=active`, `?importer=notes`, `?name.contains=`, `?sort=nextRunAt`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(recordScheduleSchema) })
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: RECORD_SCHEDULE_LIST.schema }) query: ListQuery,
  ) {
    return RECORD_SCHEDULE_LIST.pick(
      await this.schedules.page(user, query),
      query,
    );
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview the next occurrences',
    description:
      'The next moments (up to 20) a schedule with this rule, start, time, zone and calendar would create records, from now. Nothing is saved.',
  })
  @ApiOkResponse({ standardSchema: previewSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  preview(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: previewRecordScheduleSchema })
    dto: PreviewRecordScheduleDto,
  ) {
    return this.schedules.preview(dto, user);
  }

  @Post()
  @ApiOperation({
    summary: 'Schedule recurring records',
    description:
      "Creates the `template` (one row of an importer, as a file import takes it) as you at every occurrence of `rrule` from `startDate` at `time` in `timezone`, optionally moved into a business calendar's working time. Each occurrence makes one record, however often it is retried. Missed occurrences (downtime) are made up, oldest first, a few per pass; pausing skips a period. At most 20 active schedules, 1000 records each. Audited (`recordSchedule.created`).",
  })
  @ApiCreatedResponse({ standardSchema: recordScheduleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({
    description:
      'The template sets a field your permissions hide (field_forbidden), or the session is impersonating a user.',
  })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: createRecordScheduleSchema }) dto: CreateRecordScheduleDto,
    @Ip() ip: string,
  ) {
    return this.schedules.create(user, dto, ip);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of your recurring record schedules' })
  @ApiOkResponse({ standardSchema: recordScheduleSchema })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.schedules.get(user, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a recurring record schedule',
    description:
      "Only what is sent changes; an active schedule's next run is computed again from now when its rule, start, time, zone or calendar changes. Audited (`recordSchedule.updated`).",
  })
  @ApiOkResponse({ standardSchema: recordScheduleSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiConflictResponse({ description: 'The schedule has ended.' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateRecordScheduleSchema }) dto: UpdateRecordScheduleDto,
    @Ip() ip: string,
  ) {
    return this.schedules.update(user, id, dto, ip);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause a schedule',
    description:
      'No records are created until it is resumed, and the occurrences in between are not made up.',
  })
  @ApiOkResponse({ standardSchema: recordScheduleSchema })
  @ApiConflictResponse({ description: 'The schedule has ended.' })
  @ApiNotFoundResponse()
  pause(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.schedules.pause(user, id, ip);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume a paused schedule',
    description: 'Continues at the first occurrence after now.',
  })
  @ApiOkResponse({ standardSchema: recordScheduleSchema })
  @ApiBadRequestResponse({ description: 'More than 20 active schedules.' })
  @ApiConflictResponse({ description: 'The schedule has ended.' })
  @ApiNotFoundResponse()
  resume(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.schedules.resume(user, id, ip);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End a schedule for good',
    description: 'The records it made stay. It cannot be resumed.',
  })
  @ApiOkResponse({ standardSchema: recordScheduleSchema })
  @ApiNotFoundResponse()
  end(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.schedules.end(user, id, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a recurring record schedule',
    description:
      'Audited (`recordSchedule.deleted`). The records it made stay.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.schedules.remove(user, id, ip);
  }
}
