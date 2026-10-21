import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { unsubscribeSchema } from './notification.schemas.js';
import { NotificationUnsubscribeService } from './notification-unsubscribe.service.js';

/**
 * The target of the `List-Unsubscribe` header of notification mail (RFC 8058).
 * Public: the mail client (Gmail, Yahoo, Apple Mail) POSTs without any
 * sign-in; the signed token in the path is the proof. POST only: a GET would
 * let a mail scanner that follows links switch the mail off.
 */
@ApiTags('notifications')
@Public()
@Controller('notifications/unsubscribe')
export class NotificationUnsubscribeController {
  constructor(private readonly unsubscribe: NotificationUnsubscribeService) {}

  @Post(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'One-click unsubscribe from notification mail',
    description:
      "No sign-in: the token of the mail's `List-Unsubscribe` link (RFC 8058). Switches the mail of that notification type (or of that digest's types) off in the user's preferences; mandatory types are never switched off. Repeating it changes nothing. The body is the form `List-Unsubscribe=One-Click` mail clients post (JSON with the same field works too). Audited (`notificationPreferences.updated`, `via: unsubscribe`).",
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    description:
      'The link is invalid or expired, the account is gone, or the body is not `List-Unsubscribe=One-Click`: the link errors share one answer.',
  })
  async unsubscribeByLink(
    @Param('token') token: string,
    @Body({ schema: unsubscribeSchema })
    _body: z.infer<typeof unsubscribeSchema>,
    @Ip() ip: string,
  ) {
    await this.unsubscribe.unsubscribe(token, ip);
  }
}
