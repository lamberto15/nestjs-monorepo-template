import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  ForbiddenException,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import type { ListQuery } from '../../core/http/list-query.js';
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import type { Principal, UserPrincipal } from '../../iam/auth/principal.js';
import { NOTIFICATION_LIST } from './notification.list.js';
import {
  notificationSchema,
  notificationTypeSchema,
  preferencesInputSchema,
  preferencesViewSchema,
  quietHoursInputSchema,
  quietHoursViewSchema,
  readAllResultSchema,
  readAllSchema,
  unreadCountSchema,
} from './notification.schemas.js';
import { NotificationsService } from './notifications.service.js';

/** The signed-in person: quiet hours are theirs alone (not an API client's, not while an administrator acts as them). */
function person(principal: Principal): UserPrincipal {
  if (principal.kind !== 'user') {
    throw new ForbiddenException('Quiet hours belong to people.');
  }
  notWhileImpersonating(principal);
  return principal;
}

/**
 * The caller's notifications (a user's or an API client's): what they were
 * told, read or not, and how they want to be told. Nothing here needs a
 * permission: every route is about the caller's own.
 */
@ApiTags('notifications')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Your notifications, newest first',
    description:
      "The texts are in the request's language. Filter with `?read=false`, `?type=note.published`, `?createdAt.gte=…`; page by cursor; each parameter lists what it takes.",
  })
  @ApiOkResponse({ standardSchema: pageSchema(notificationSchema) })
  async list(
    @CurrentUser() user: Principal,
    @Query({ schema: NOTIFICATION_LIST.schema }) query: ListQuery,
  ) {
    return NOTIFICATION_LIST.pick(
      await this.notifications.page(user, query),
      query,
    );
  }

  @Get('unread-count')
  @Can.Anyone()
  @ApiOperation({ summary: 'How many of your notifications are unread' })
  @ApiOkResponse({ standardSchema: unreadCountSchema })
  unreadCount(@CurrentUser() user: Principal) {
    return this.notifications.unreadCount(user);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @Can.Anyone()
  @ApiOperation({
    summary: 'Mark all your notifications read',
    description:
      'With `before`, only those created before it: what the client has shown, leaving newer ones unread.',
  })
  @ApiOkResponse({ standardSchema: readAllResultSchema })
  readAll(
    @CurrentUser() user: Principal,
    @Body({ schema: readAllSchema }) body: z.infer<typeof readAllSchema>,
  ) {
    // The person's own: an administrator acting as them changes none of it.
    notWhileImpersonating(user);
    return this.notifications.markAllRead(
      user,
      body.before ? new Date(body.before) : undefined,
    );
  }

  @Get('types')
  @Can.Anyone()
  @ApiOperation({
    summary: 'The notification types, and the channels you may set for each',
  })
  @ApiOkResponse({ standardSchema: listSchema(notificationTypeSchema) })
  types(@CurrentUser() user: Principal) {
    return { items: this.notifications.types(user) };
  }

  @Get('preferences')
  @Can.Anyone()
  @ApiOperation({
    summary: 'How you are told of each type: your settings, per channel',
    description:
      'Users set `email` (false, immediate, hourly or daily); API clients set `webhook` (the notification.created event). In-app and realtime are always on.',
  })
  @ApiOkResponse({ standardSchema: preferencesViewSchema })
  preferences(@CurrentUser() user: Principal) {
    // Account-wide (every tenant's): not shown to an administrator acting as them.
    notWhileImpersonating(user);
    return this.notifications.preferences(user);
  }

  @Put('preferences')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Change how you are told',
    description:
      'The body replaces your settings: a type or channel left out goes back to its default. On a mandatory type, a channel that is on by default cannot be switched off (one off by default may stay off: what GET answers, PUT takes back). Audited.',
  })
  @ApiOkResponse({ standardSchema: preferencesViewSchema })
  @ApiBadRequestResponse({
    description:
      'An unknown type or channel, a value the channel does not take, or, on a mandatory type, a channel that is on by default switched off (validation_failed, each error naming `<type>.<channel>`).',
  })
  updatePreferences(
    @CurrentUser() user: Principal,
    @Body({ schema: preferencesInputSchema })
    body: z.infer<typeof preferencesInputSchema>,
    @Ip() ip: string,
  ) {
    // The person's own: an administrator acting as them changes none of it.
    notWhileImpersonating(user);
    return this.notifications.updatePreferences(user, body, ip);
  }

  @Get('quiet-hours')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Your quiet hours',
    description:
      'While the clock of your time zone is inside the window, push and SMS wait for it to end (types marked `urgent` do not). In-app, realtime and email are unaffected.',
  })
  @ApiOkResponse({ standardSchema: quietHoursViewSchema })
  @ApiForbiddenResponse({ description: 'An API client has no quiet hours.' })
  quietHours(@CurrentUser() user: Principal) {
    return this.notifications.quietHours(person(user));
  }

  @Put('quiet-hours')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Set your quiet hours',
    description:
      'A window on the clock of your time zone (`PATCH /auth/me { timezone }`, else the deployment’s), as `HH:MM`; one past midnight (`22:00` to `07:00`) is fine. Push and SMS of a non-urgent notification arriving inside it are sent when it ends. Audited.',
  })
  @ApiOkResponse({ standardSchema: quietHoursViewSchema })
  @ApiBadRequestResponse({ description: 'validation_failed.' })
  setQuietHours(
    @CurrentUser() user: Principal,
    @Body({ schema: quietHoursInputSchema })
    body: z.infer<typeof quietHoursInputSchema>,
    @Ip() ip: string,
  ) {
    return this.notifications.setQuietHours(person(user), body, ip);
  }

  @Delete('quiet-hours')
  @HttpCode(HttpStatus.OK)
  @Can.Anyone()
  @ApiOperation({ summary: 'Remove your quiet hours' })
  @ApiOkResponse({ standardSchema: quietHoursViewSchema })
  clearQuietHours(@CurrentUser() user: Principal, @Ip() ip: string) {
    return this.notifications.setQuietHours(person(user), null, ip);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @Can.Anyone()
  @ApiOperation({ summary: 'Mark one of your notifications read' })
  @ApiOkResponse({ standardSchema: notificationSchema })
  @ApiNotFoundResponse({ description: 'Not yours, or gone.' })
  markRead(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // The person's own: an administrator acting as them changes none of it.
    notWhileImpersonating(user);
    return this.notifications.markRead(user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({ summary: 'Remove one of your notifications' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not yours, or gone.' })
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // The person's own: an administrator acting as them changes none of it.
    notWhileImpersonating(user);
    await this.notifications.remove(user, id);
  }
}
