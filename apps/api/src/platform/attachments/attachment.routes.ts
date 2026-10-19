import {
  BadRequestException,
  Body,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  type Type,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { StoredUpload } from '@nestjs/storage';
import {
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
} from '../records/record-routes.js';
import { ATTACHMENT_LIST } from './attachment.list.js';
import {
  attachmentPageSchema,
  attachmentSchema,
  attachmentUploadSchema,
} from './attachment.schemas.js';
import { AttachmentUpload } from './attachment-upload.interceptor.js';
import { AttachmentsService } from './attachments.service.js';

/**
 * `/<path>/{id}/attachments`: add a file to a record, list them (checked on
 * the record by the feature's AttachmentTarget). Downloading and removing
 * one are /v1/attachments/{id}/….
 */
export function attachmentRoutes(spec: RecordRouteSpec): Type {
  const { subject, noun } = spec;

  @Can.Anyone() // Checked on the record: the feature's AttachmentTarget.
  @RecordController(spec, spec.path)
  class AttachmentRoutes {
    constructor(private readonly attachments: AttachmentsService) {}

    @Post(':id/attachments')
    @UseInterceptors(AttachmentUpload(subject))
    @ApiConsumes('multipart/form-data')
    @ApiOperation({
      summary: `Attach a file to ${aNounOf(spec)}`,
      description: `Who may change the ${noun} (${subject}.update). Multipart, the field \`file\`. Its type is read from its bytes: allowed types only (ATTACHMENT_ALLOWED_TYPES), and not another one than declared. Audited (attachment.added).`,
    })
    @ApiCreatedResponse({ standardSchema: attachmentSchema })
    @ApiForbiddenResponse({ description: `You may not change the ${noun}.` })
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
      return this.attachments.upload(user, { subject, recordId: id }, file, ip);
    }

    @Get(':id/attachments')
    @ApiOperation({
      summary: `${aNounOf(spec).replace(/^a/, 'A')}'s attachments, newest first`,
      description: `Whoever may read the ${noun}.`,
    })
    @ApiOkResponse({ standardSchema: attachmentPageSchema })
    @ApiNotFoundResponse()
    async list(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query({ schema: ATTACHMENT_LIST.schema }) query: ListQuery,
    ) {
      return ATTACHMENT_LIST.pick(
        await this.attachments.list(user, { subject, recordId: id }, query),
        query,
      );
    }
  }
  return namedController(
    AttachmentRoutes,
    `${spec.className}AttachmentsController`,
  );
}
