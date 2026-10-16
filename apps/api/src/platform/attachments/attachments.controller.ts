import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Redirect,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import {
  AttachmentsService,
  DOWNLOAD_LINK_TTL,
} from './attachments.service.js';

/**
 * One attachment, whatever its record: download it, remove it. Uploading
 * and listing are on the record's own routes (`/notes/{id}/attachments`),
 * which the feature adds.
 */
@ApiTags('attachments')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked by the service: the record's own rules.
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download an attachment',
    description: `Whoever may read its record. Redirects to a signed link to the file, valid for ${DOWNLOAD_LINK_TTL}: it needs no credentials, so a browser can follow it (a link, an image).`,
  })
  @ApiFoundResponse({ description: 'To the file (a signed link).' })
  @ApiNotFoundResponse()
  download(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachments.download(user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an attachment',
    description:
      'Your own upload, or any attachment of a record you may change (for notes: Note.update). The file is deleted too. Audited (attachment.removed). Never an issued document (`locked`).',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description:
      'An issued document (attachment_locked): it stays with its record.',
  })
  @ApiForbiddenResponse({
    description: 'Not yours, and you may not change its record.',
  })
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.attachments.remove(user, id, ip);
  }
}
