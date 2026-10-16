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
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { NOTIFICATION_LIST } from './notification.list.js';
import {
  notificationSchema,
  notificationTypeSchema,
  preferencesInputSchema,
  preferencesViewSchema,
  readAllResultSchema,
  readAllSchema,
  unreadCountSchema,
} from './notification.schemas.js';
import { NotificationsService } from './notifications.service.js';

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
    return this.notifications.preferences(user);
  }

  @Put('preferences')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Change how you are told',
    description:
      'The body replaces your settings: a type or channel left out goes back to its default. A mandatory type cannot be switched off. Audited.',
  })
  @ApiOkResponse({ standardSchema: preferencesViewSchema })
  @ApiBadRequestResponse({
    description:
      'An unknown type or channel, a value the channel does not take, or a mandatory type switched off (validation_failed, each error naming `<type>.<channel>`).',
  })
  updatePreferences(
    @CurrentUser() user: Principal,
    @Body({ schema: preferencesInputSchema })
    body: z.infer<typeof preferencesInputSchema>,
    @Ip() ip: string,
  ) {
    return this.notifications.updatePreferences(user, body, ip);
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
    await this.notifications.remove(user, id);
  }
}
