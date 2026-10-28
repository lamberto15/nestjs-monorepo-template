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
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  calendarListSchema,
  calendarSchema,
  type CreateCalendarDto,
  createCalendarSchema,
  type DeadlineRequestDto,
  deadlineRequestSchema,
  deadlineSchema,
  type UpdateCalendarDto,
  updateCalendarSchema,
} from './calendar.schemas.js';
import { CalendarsService } from './calendars.service.js';

/**
 * Business calendars: working hours, time zone and holidays, and the
 * deadline calculation on them. Anyone signed in reads them and computes
 * deadlines; creating, changing and deleting takes Access.manageCalendars.
 */
@ApiTags('calendars')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('calendars')
export class CalendarsController {
  constructor(private readonly calendars: CalendarsService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: "The tenant's business calendars, by name",
    description: 'At most 50 per tenant, so one list (no pages).',
  })
  @ApiOkResponse({ standardSchema: calendarListSchema })
  list() {
    return this.calendars.list();
  }

  @Get(':id')
  @Can.Anyone()
  @ApiOperation({ summary: 'A business calendar' })
  @ApiOkResponse({ standardSchema: calendarSchema })
  @ApiNotFoundResponse()
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.calendars.findOne(id);
  }

  @Post()
  @Can(AccessPolicy, 'manageCalendars')
  @ApiOperation({
    summary: 'Create a business calendar',
    description:
      'Hours per weekday and exceptions (a holiday: no `hours`; special hours), in an IANA `timezone`. Audited (`businessCalendar.created`).',
  })
  @ApiCreatedResponse({ standardSchema: calendarSchema })
  @ApiBadRequestResponse({
    description:
      'An unknown time zone, a bad or overlapping span, a date twice, more than 50 calendars (validation_failed).',
  })
  @ApiConflictResponse({ description: 'A calendar has this name.' })
  create(
    @CurrentUser() user: Principal,
    @Body({ schema: createCalendarSchema }) dto: CreateCalendarDto,
    @Ip() ip: string,
  ) {
    return this.calendars.create(user, dto, ip);
  }

  @Patch(':id')
  @Can(AccessPolicy, 'manageCalendars')
  @ApiOperation({
    summary: 'Change a business calendar',
    description:
      'Only what is sent changes; hours and exceptions are replaced whole. A change of hours, zone or exceptions raises `version`. Deadlines already computed are not recomputed: ask again. Audited (`businessCalendar.updated`).',
  })
  @ApiOkResponse({ standardSchema: calendarSchema })
  @ApiBadRequestResponse({
    description: 'An invalid body (validation_failed).',
  })
  @ApiConflictResponse({ description: 'A calendar has this name.' })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateCalendarSchema }) dto: UpdateCalendarDto,
    @Ip() ip: string,
  ) {
    return this.calendars.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can(AccessPolicy, 'manageCalendars')
  @ApiOperation({
    summary: 'Delete a business calendar',
    description: 'Audited (`businessCalendar.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description: 'A recurring schedule still follows it.',
  })
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.calendars.remove(user, id, ip);
  }

  @Post(':id/deadline')
  @HttpCode(HttpStatus.OK)
  @Can.Anyone()
  @ApiOperation({
    summary: 'A deadline in working time',
    description:
      "`minutes` of working time after `from`, skipping nights, weekends and exceptions in the calendar's zone (daylight-saving changes followed); 0 minutes: the first working moment at or after `from`. Returns the calendar `version` to store beside the deadline.",
  })
  @ApiOkResponse({ standardSchema: deadlineSchema })
  @ApiBadRequestResponse({
    description:
      'The calendar has no working time in the next ten years (calendar_has_no_working_time).',
  })
  @ApiNotFoundResponse()
  deadline(
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: deadlineRequestSchema }) dto: DeadlineRequestDto,
  ) {
    return this.calendars.deadline(id, new Date(dto.from), dto.minutes);
  }
}
