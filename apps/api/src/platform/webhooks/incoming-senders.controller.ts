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
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RecentAuthentication } from '../../iam/auth/recent-authentication.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import {
  type CreateIncomingSenderDto,
  createdIncomingSenderSchema,
  createIncomingSenderSchema,
  incomingSenderListSchema,
  incomingSenderSchema,
  type RotateIncomingSenderDto,
  rotateIncomingSenderSchema,
  type UpdateIncomingSenderDto,
  updateIncomingSenderSchema,
} from './incoming-sender.schemas.js';
import { IncomingSendersService } from './incoming-senders.service.js';

/**
 * The senders of the tenant's incoming webhooks: who may POST to
 * `/v1/webhooks/tenants/{tenantId}/senders/{name}`, and with which secret.
 * A user (a session or a user token) with `Access.manageClients`, in the
 * tenant they act in; creating a sender and rotating its secret return a
 * secret and want a recent sign-in.
 */
@ApiTags('incoming webhooks', 'access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session (an API key is none).' })
@ApiForbiddenResponse({
  description:
    'Not allowed by your permissions, or a step-up is due (reauthentication_required).',
})
@UserOnly()
@Can(AccessPolicy, 'manageClients')
@Controller('webhook-senders')
export class IncomingSendersController {
  constructor(private readonly senders: IncomingSendersService) {}

  @Get()
  @ApiOperation({ summary: "The tenant's incoming webhook senders" })
  @ApiOkResponse({ standardSchema: incomingSenderListSchema })
  list() {
    return this.senders.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One sender' })
  @ApiOkResponse({ standardSchema: incomingSenderSchema })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.senders.get(id);
  }

  @Post()
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Register a sender',
    description:
      'The secret is in the response, this once. The sender signs its calls with it (Standard Webhooks) and POSTs to the returned `path`. Audited (`webhookSender.created`).',
  })
  @ApiCreatedResponse({ standardSchema: createdIncomingSenderSchema })
  @ApiBadRequestResponse({
    description: 'An invalid name (validation_failed).',
  })
  @ApiConflictResponse({ description: 'The tenant has a sender of this name.' })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createIncomingSenderSchema }) dto: CreateIncomingSenderDto,
    @Ip() ip: string,
  ) {
    return this.senders.create(user, dto, ip);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Describe, disable or enable a sender',
    description: 'Audited (`webhookSender.updated`).',
  })
  @ApiOkResponse({ standardSchema: incomingSenderSchema })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateIncomingSenderSchema }) dto: UpdateIncomingSenderDto,
    @Ip() ip: string,
  ) {
    return this.senders.update(user, id, dto, ip);
  }

  @Post(':id/rotate-secret')
  @RecentAuthentication()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A new secret (the old one verifies for a grace period)',
    description:
      'The new secret is in the response, this once; the old one keeps verifying for `graceSeconds` (default 24 hours). Audited (`webhookSender.secret-rotated`).',
  })
  @ApiOkResponse({ standardSchema: createdIncomingSenderSchema })
  @ApiNotFoundResponse()
  rotate(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: rotateIncomingSenderSchema }) dto: RotateIncomingSenderDto,
    @Ip() ip: string,
  ) {
    return this.senders.rotate(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a sender',
    description:
      'Its calls are refused (401) from now on. Audited (`webhookSender.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.senders.remove(user, id, ip);
  }
}
