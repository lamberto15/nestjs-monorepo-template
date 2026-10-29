import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Throttle, minutes } from '@nestjs/throttler';
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
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import type { Principal, UserPrincipal } from '../../iam/auth/principal.js';
import { listSchema } from '../../core/http/pagination.js';
import {
  deviceSchema,
  phoneSchema,
  registerDeviceSchema,
  setPhoneSchema,
  verifyPhoneSchema,
  webPushSchema,
} from './messaging.schemas.js';
import { MessagingService } from './messaging.service.js';

/** The signed-in person as a user: devices and numbers belong to people, not API clients. */
function personal(principal: Principal): UserPrincipal {
  if (principal.kind !== 'user') {
    throw new ForbiddenException('Devices and numbers belong to people.');
  }
  notWhileImpersonating(principal);
  return principal;
}

/**
 * The caller's push devices and SMS number (docs/notifications.md, "Push and
 * SMS"). Nothing here needs a permission: every route is about the caller's
 * own, and a person's alone (not an API client's, not while an administrator
 * acts as them). Tokens and the number are never returned in clear.
 */
@ApiTags('messaging')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session.' })
@ApiForbiddenResponse({
  description: 'An API client, or an administrator acting as the person.',
})
@Controller()
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Put('devices')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Register this device for push, or refresh it',
    description:
      'Call it whenever the app opens: the same token again updates the name and the last-seen time. A token another person registered moves to you. A device not seen for DEVICES_RETENTION_DAYS is removed. The token is stored encrypted and never returned.',
  })
  @ApiOkResponse({ standardSchema: deviceSchema })
  @ApiBadRequestResponse({ description: 'validation_failed.' })
  registerDevice(
    @CurrentUser() user: Principal,
    @Body({ schema: registerDeviceSchema })
    body: z.infer<typeof registerDeviceSchema>,
    @Ip() ip: string,
  ) {
    return this.messaging.registerDevice(personal(user), body, ip);
  }

  @Get('devices/web-push')
  @Can.Anyone()
  @ApiOperation({
    summary: 'What a browser needs to register for push',
    description:
      'The VAPID public key for `pushManager.subscribe()`; then register the subscription with PUT /v1/devices (platform `web`). Null when Web Push is off (PUSH_PROVIDER).',
  })
  @ApiOkResponse({ standardSchema: webPushSchema })
  webPush() {
    return this.messaging.webPush();
  }

  @Get('devices')
  @Can.Anyone()
  @ApiOperation({ summary: 'Your registered devices' })
  @ApiOkResponse({ standardSchema: listSchema(deviceSchema) })
  async devices(@CurrentUser() user: Principal) {
    return { items: await this.messaging.devicesOf(personal(user)) };
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({ summary: 'Remove a device: its token is deleted' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not one of your devices.' })
  async removeDevice(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.messaging.removeDevice(personal(user), id, ip);
  }

  @Get('messaging/phone')
  @Can.Anyone()
  @ApiOperation({
    summary: 'Your SMS number (masked), and whether it is verified',
  })
  @ApiOkResponse({ standardSchema: phoneSchema })
  phone(@CurrentUser() user: Principal) {
    return this.messaging.phoneOf(personal(user));
  }

  @Put('messaging/phone')
  @Can.Anyone()
  // Each call texts a code: bounded per client IP, on top of the daily caps per user.
  @Throttle({ default: { limit: 5, ttl: minutes(10) } })
  @ApiOperation({
    summary: 'Set your SMS number',
    description:
      'With its country code (E.164). Texts a six-digit code to confirm it (`POST /messaging/phone/verify`); the number is not used before that. Only the countries in SMS_ALLOWED_PREFIXES are accepted. A different number starts unverified.',
  })
  @ApiOkResponse({ standardSchema: phoneSchema })
  @ApiBadRequestResponse({
    description: 'phone_invalid, or phone_country_not_allowed.',
  })
  setPhone(
    @CurrentUser() user: Principal,
    @Body({ schema: setPhoneSchema }) body: z.infer<typeof setPhoneSchema>,
    @Ip() ip: string,
  ) {
    return this.messaging.setPhone(personal(user), body.phone, ip);
  }

  @Post('messaging/phone/verify')
  @HttpCode(HttpStatus.OK)
  @Can.Anyone()
  @Throttle({ default: { limit: 10, ttl: minutes(10) } })
  @ApiOperation({
    summary: 'Confirm your SMS number with the code texted to it',
    description:
      'The code lasts ten minutes and is void after five wrong guesses.',
  })
  @ApiOkResponse({ standardSchema: phoneSchema })
  @ApiBadRequestResponse({ description: 'code_invalid.' })
  @ApiNotFoundResponse({ description: 'No number set.' })
  verifyPhone(
    @CurrentUser() user: Principal,
    @Body({ schema: verifyPhoneSchema })
    body: z.infer<typeof verifyPhoneSchema>,
    @Ip() ip: string,
  ) {
    return this.messaging.verifyPhone(personal(user), body.code, ip);
  }

  @Delete('messaging/phone')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({ summary: 'Remove your SMS number' })
  @ApiNoContentResponse()
  async removePhone(@CurrentUser() user: Principal, @Ip() ip: string) {
    await this.messaging.removePhone(personal(user), ip);
  }
}
