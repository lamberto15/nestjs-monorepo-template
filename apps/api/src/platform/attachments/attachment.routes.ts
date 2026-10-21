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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
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
  type AttachmentPresign,
  attachmentCompleteSchema,
  attachmentPageSchema,
  attachmentPresignSchema,
  attachmentSchema,
  attachmentUploadSchema,
  presignedUploadSchema,
} from './attachment.schemas.js';
import { AttachmentUpload } from './attachment-upload.interceptor.js';
import { AttachmentUploadsService } from './attachment-uploads.service.js';
import { AttachmentsService } from './attachments.service.js';

/**
 * `/<path>/{id}/attachments`: add a file to a record, list them (checked on
 * the record by the feature's AttachmentTarget), and, with
 * `STORAGE_DRIVER=s3`, add one straight to the object store (`/presign`,
 * `/complete`). Downloading and removing one are /v1/attachments/{id}/….
 */
export function attachmentRoutes(spec: RecordRouteSpec): Type {
  const { subject, noun } = spec;

  @Can.Anyone() // Checked on the record: the feature's AttachmentTarget.
  @RecordController(spec, spec.path)
  class AttachmentRoutes {
    constructor(
      private readonly attachments: AttachmentsService,
      private readonly uploads: AttachmentUploadsService,
    ) {}

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

    @Post(':id/attachments/presign')
    @ApiOperation({
      summary: `Announce a direct upload of a file to ${aNounOf(spec)}`,
      description: `For \`STORAGE_DRIVER=s3\` (\`GET /v1/features\`: \`presignedUploads\`), instead of streaming the file through the API: who may change the ${noun} (${subject}.update). Send the file's name, size and type; answer a URL to PUT the file to (signed for exactly that size and \`Content-Type\`, for ten minutes, at a key the server chose under your tenant) and an \`uploadId\`. Then \`POST …/attachments/complete\` with it. Nothing is attached until then.`,
    })
    @ApiCreatedResponse({ standardSchema: presignedUploadSchema })
    @ApiForbiddenResponse({ description: `You may not change the ${noun}.` })
    @ApiNotFoundResponse()
    @ApiPayloadTooLargeResponse({
      description: 'Larger than ATTACHMENT_MAX_MB (payload_too_large).',
    })
    @ApiUnsupportedMediaTypeResponse({
      description:
        'A type not allowed, or none declared (unsupported_media_type).',
    })
    @ApiTooManyRequestsResponse({
      description:
        'Too many uploads announced and not completed (attachment_uploads_pending).',
    })
    @ApiServiceUnavailableResponse({
      description:
        'The server stores files on a local disk (presigned_uploads_unavailable): upload with a multipart POST.',
    })
    presign(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: attachmentPresignSchema }) body: AttachmentPresign,
    ) {
      return this.uploads.presign(user, { subject, recordId: id }, body);
    }

    @Post(':id/attachments/complete')
    @ApiOperation({
      summary: `Complete a direct upload to ${aNounOf(spec)}`,
      description: `After the PUT to the URL of \`POST …/attachments/presign\`: the server reads the object back (its size and type from the store, its first bytes for the type the bytes say, never the client's word), deletes it if it is not what was announced, and otherwise attaches it exactly as an upload through the API does (\`attachment.added\`, the quota, the malware scan, the image renditions). Only the one who announced the upload may complete it.`,
    })
    @ApiCreatedResponse({ standardSchema: attachmentSchema })
    @ApiBadRequestResponse({
      description:
        'The object is not the size and type announced (attachment_upload_mismatch); it is deleted.',
    })
    @ApiForbiddenResponse({ description: `You may not change the ${noun}.` })
    @ApiNotFoundResponse({
      description: `No such ${noun}, or no such upload of yours (attachment_upload_not_found).`,
    })
    @ApiConflictResponse({
      description:
        'Nothing was PUT yet (attachment_upload_incomplete: try again), or another request is completing it (attachment_upload_in_progress).',
    })
    @ApiGoneResponse({
      description:
        "More than an hour past the URL's expiry (attachment_upload_expired): announce it again.",
    })
    @ApiPayloadTooLargeResponse({
      description:
        'Larger than ATTACHMENT_MAX_MB (payload_too_large); deleted.',
    })
    @ApiUnsupportedMediaTypeResponse({
      description:
        'The bytes are a type not allowed, or not the one declared (unsupported_media_type); deleted.',
    })
    @ApiServiceUnavailableResponse({
      description:
        'The server stores files on a local disk (presigned_uploads_unavailable).',
    })
    complete(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: attachmentCompleteSchema })
      body: { uploadId: string },
      @Ip() ip: string,
    ) {
      return this.uploads.complete(
        user,
        { subject, recordId: id },
        body.uploadId,
        ip,
      );
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
