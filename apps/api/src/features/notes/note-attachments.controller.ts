import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { StoredUpload } from '@nestjs/storage';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { ATTACHMENT_LIST } from '../../platform/attachments/attachment.list.js';
import {
  attachmentSchema,
  attachmentUploadSchema,
} from '../../platform/attachments/attachment.schemas.js';
import { AttachmentUpload } from '../../platform/attachments/attachment-upload.interceptor.js';
import { AttachmentsService } from '../../platform/attachments/attachments.service.js';

/**
 * A note's attachments (platform/attachments): add one, list them.
 * Downloading and removing one are /v1/attachments/{id}/….
 */
@ApiTags('notes')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked on the note: NoteAttachments.
@Controller('notes')
export class NoteAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post(':id/attachments')
  @UseInterceptors(AttachmentUpload('Note'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Attach a file to a note',
    description:
      'Who may change the note (Note.update). Multipart, the field `file`. Its type is read from its bytes: allowed types only (ATTACHMENT_ALLOWED_TYPES), and not another one than declared. Audited (attachment.added).',
  })
  @ApiCreatedResponse({ standardSchema: attachmentSchema })
  @ApiForbiddenResponse({ description: 'You may not change the note.' })
  @ApiNotFoundResponse()
  @ApiPayloadTooLargeResponse({
    description: 'Larger than ATTACHMENT_MAX_MB (payload_too_large).',
  })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'A type not allowed, or not the one declared (unsupported_media_type).',
  })
  async upload(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Body({ schema: attachmentUploadSchema }) _body: unknown,
    @Ip() ip: string,
  ) {
    if (!file) {
      throw new BadRequestException('Attach the file as the "file" field.');
    }
    return this.attachments.upload(
      user,
      { subject: 'Note', recordId: id },
      file,
      ip,
    );
  }

  @Get(':id/attachments')
  @ApiOperation({
    summary: "A note's attachments, newest first",
    description: 'Whoever may read the note.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(attachmentSchema) })
  @ApiNotFoundResponse()
  async list(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: ATTACHMENT_LIST.schema }) query: ListQuery,
  ) {
    return ATTACHMENT_LIST.pick(
      await this.attachments.list(
        user,
        { subject: 'Note', recordId: id },
        query,
      ),
      query,
    );
  }
}
