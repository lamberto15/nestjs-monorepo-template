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
import type { Principal } from '../../iam/auth/principal.js';
import {
  type AcknowledgmentRemindDto,
  acknowledgmentRemindResultSchema,
  acknowledgmentRemindSchema,
  type AcknowledgmentRequestDto,
  acknowledgmentRequestSchema,
  acknowledgmentSchema,
  acknowledgmentStatusQuerySchema,
  type AcknowledgmentStatusQuery,
  acknowledgmentStatusSchema,
  acknowledgmentVersionQuerySchema,
  type AcknowledgmentVersionQuery,
  myAcknowledgmentListSchema,
} from './acknowledgment.schemas.js';
import { AcknowledgmentsService } from './acknowledgments.service.js';
import { z } from 'zod';

/**
 * A document's acknowledgments: who is asked to confirm they read its
 * version, and who did. Checked by the service on the document's record:
 * the requester may change it, the recipient may read it.
 */
@ApiTags('acknowledgments')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiNotFoundResponse({
  description: 'No such document, or its record may not be read.',
})
@Can.Anyone() // Checked by the service: the document's record.
@Controller('attachments/:id')
export class AttachmentAcknowledgmentsController {
  constructor(private readonly acknowledgments: AcknowledgmentsService) {}

  @Post('acknowledgment-requests')
  @ApiOperation({
    summary: 'Ask people to acknowledge a document',
    description:
      "Whoever may change the document's record. Each person is asked about its current version (`version`; 1 while attachments are unversioned); those already asked keep their answer. They must be members who may read the record. They are told (`acknowledgment.requested`). Audited. An acknowledgment records that the person confirmed reading that version, and when; it is not a signature.",
  })
  @ApiCreatedResponse({ standardSchema: acknowledgmentSchema.array() })
  @ApiBadRequestResponse({
    description:
      'A recipient is not a member who may read it (acknowledgment_recipient_invalid), or the deadline is past (acknowledgment_due_in_past).',
  })
  @ApiForbiddenResponse({ description: 'You may not change its record.' })
  @ApiConflictResponse({
    description: 'More than 500 people for one version (acknowledgment_limit).',
  })
  request(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: acknowledgmentRequestSchema })
    body: AcknowledgmentRequestDto,
    @Ip() ip: string,
  ) {
    return this.acknowledgments.request(
      user,
      id,
      body.recipients,
      body.dueAt,
      ip,
    );
  }

  @Get('acknowledgments')
  @ApiOperation({
    summary: "A document's acknowledgments (completion dashboard)",
    description:
      "Whoever may change the document's record: counts and each person's state for a version (`?version=`, default the current).",
  })
  @ApiOkResponse({ standardSchema: acknowledgmentStatusSchema })
  @ApiForbiddenResponse({ description: 'You may not change its record.' })
  status(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: acknowledgmentVersionQuerySchema })
    query: AcknowledgmentVersionQuery,
  ) {
    return this.acknowledgments.status(user, id, query.version);
  }

  @Post('acknowledgments/remind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remind those who have not acknowledged',
    description:
      'Whoever may change the record. Everyone still waiting, or the named `recipients`; nobody twice within 24 hours (`skipped`). Told with `acknowledgment.reminder`. Audited.',
  })
  @ApiOkResponse({ standardSchema: acknowledgmentRemindResultSchema })
  @ApiForbiddenResponse({ description: 'You may not change its record.' })
  remind(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: acknowledgmentRemindSchema }) body: AcknowledgmentRemindDto,
    @Ip() ip: string,
  ) {
    return this.acknowledgments.remind(user, id, body.recipients, ip);
  }

  @Delete('acknowledgments/:acknowledgmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Withdraw a request',
    description:
      'Whoever may change the record. Only one nobody has answered; an answer stays. Audited.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description: 'Already acknowledged (acknowledgment_answered).',
  })
  async withdraw(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('acknowledgmentId', ParseUUIDPipe) acknowledgmentId: string,
    @Ip() ip: string,
  ) {
    await this.acknowledgments.withdraw(user, id, acknowledgmentId, ip);
  }

  @Post('acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge a document',
    description:
      "The person asked, for the document's current version; acknowledging again changes nothing. A 404 for anyone nobody asked. Audited (`acknowledgment.acknowledged`).",
  })
  @ApiOkResponse({ standardSchema: acknowledgmentSchema })
  acknowledge(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.acknowledgments.acknowledge(user, id, ip);
  }
}

/** The caller's own acknowledgments, whatever the document. */
@ApiTags('acknowledgments')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Only the caller's own.
@Controller('acknowledgments')
export class MyAcknowledgmentsController {
  constructor(private readonly acknowledgments: AcknowledgmentsService) {}

  @Get()
  @ApiOperation({
    summary: 'Acknowledgments asked of me',
    description:
      'Newest first, at most 100, for documents whose record you may read: `?status=pending` (default) or `acknowledged`.',
  })
  @ApiOkResponse({ standardSchema: myAcknowledgmentListSchema })
  mine(
    @CurrentUser() user: Principal,
    @Query({ schema: acknowledgmentStatusQuerySchema })
    query: AcknowledgmentStatusQuery,
  ) {
    return this.acknowledgments.mine(user, query.status);
  }
}
