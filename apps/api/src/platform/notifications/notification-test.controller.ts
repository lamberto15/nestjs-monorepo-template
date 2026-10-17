import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import type { Principal } from '../../iam/auth/principal.js';
import { testNotificationResultSchema } from './notification.schemas.js';
import { NotificationsService } from './notifications.service.js';

/**
 * `POST /v1/notifications/test`: a way to try the bell, the realtime push
 * and the mail without waiting for a real event. Registered only in
 * development and tests (`inDevelopment()`, notification-test.ts), so
 * elsewhere the route does not exist: 404 like any other missing one, and
 * it is not in the OpenAPI document. Separate from NotificationsController
 * for that reason: a switch decides whether the controller is there.
 */
@ApiTags('notifications')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'An administrator acting as someone.' })
@Controller('notifications')
export class NotificationTestController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @Can.Anyone()
  @ApiOperation({
    summary: 'Send yourself a test notification (development only)',
    description:
      'Sends the caller a `system.test` notification the way a real one goes: stored for the bell, pushed to your open connections, mailed per your preference (users), sent as a `notification.created` webhook (API clients). Only in development and tests; in production the route does not exist (404).',
  })
  @ApiOkResponse({ standardSchema: testNotificationResultSchema })
  test(@CurrentUser() user: Principal) {
    // The person's own: an administrator acting as them sends them nothing.
    notWhileImpersonating(user);
    return this.notifications.sendTest(user);
  }
}
