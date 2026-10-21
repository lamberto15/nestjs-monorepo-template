import {
  Body,
  Controller,
  Get,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import {
  unsubscribeDescriptionSchema,
  unsubscribeSchema,
} from './notification.schemas.js';
import { NotificationUnsubscribeService } from './notification-unsubscribe.service.js';

/**
 * The target of the `List-Unsubscribe` header of notification mail (RFC 8058).
 * Public: the mail client (Gmail, Yahoo, Apple Mail) POSTs without any
 * sign-in; the signed token in the path is the proof. Only the POST
 * unsubscribes: a GET that did would let a mail scanner that follows links
 * switch the mail off. The GET just describes what the link would stop
 * (changes and records nothing), for the web page above its button. Both
 * are throttled by the app's default limit, as any route.
 */
@ApiTags('notifications')
@Public()
@Controller('notifications/unsubscribe')
export class NotificationUnsubscribeController {
  constructor(private readonly unsubscribe: NotificationUnsubscribeService) {}

  @Get(':token')
  @ApiOperation({
    summary: 'Which mail an unsubscribe link stops',
    description:
      "No sign-in, and read-only: it changes and records nothing, so a mail scanner that follows the link does no harm. Answers what the token of the mail's unsubscribe link stops: a notification type (`kind: type`, its `label` in the request's language) or a digest (`kind: digest`, its `modes`). Never the person's email or id. A forged, expired or foreign token, or a gone account, is the same 400 the POST gives.",
  })
  @ApiOkResponse({ standardSchema: unsubscribeDescriptionSchema })
  @ApiBadRequestResponse({
    description:
      'The link is invalid or expired, or the account is gone: the link errors share one answer, the POST included.',
  })
  describe(@Param('token') token: string) {
    return this.unsubscribe.describe(token);
  }

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
