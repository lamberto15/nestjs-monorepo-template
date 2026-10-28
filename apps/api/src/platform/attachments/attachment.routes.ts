import {
  BadRequestException,
  Body,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  type Type,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { StoredUpload } from '@nestjs/storage';
import type { Request } from 'express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiPreconditionFailedResponse,
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
  attachmentVersionNoteSchema,
  presignedUploadSchema,
  uploadChunkQuerySchema,
  uploadSessionSchema,
} from './attachment.schemas.js';
import { AttachmentUpload } from './attachment-upload.interceptor.js';
import { AttachmentUploadsService } from './attachment-uploads.service.js';
import { AttachmentVersionsService } from './attachment-versions.service.js';
import { AttachmentsService } from './attachments.service.js';
import { ifMatchHeader } from '../../core/http/etag.js';

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
      private readonly versions: AttachmentVersionsService,
    ) {}

    @Post(':id/attachments/:attachmentId/versions')
    @UseInterceptors(AttachmentUpload(subject))
    @ApiConsumes('multipart/form-data')
    @ApiHeader(ifMatchHeader())
    @ApiOperation({
      summary: `Replace the file of ${aNounOf(spec)}'s attachment with a new version`,
      description: `Who may change the ${noun} (${subject}.update). Multipart: the field \`file\` (checked like any upload: type from its bytes, size, quota, malware scan) and an optional \`note\`. The file it replaces stays as the previous version (\`GET /v1/attachments/{id}/versions\`). With \`If-Match\` (the attachment's ETag, \`GET /v1/attachments/{id}\`) it is refused (412) if the attachment changed since you read it. Audited (attachment.replaced).`,
    })
    @ApiCreatedResponse({ standardSchema: attachmentSchema })
    @ApiForbiddenResponse({ description: `You may not change the ${noun}.` })
    @ApiNotFoundResponse()
    @ApiConflictResponse({
      description:
        'An issued document (attachment_locked), still being scanned or processed (attachment_busy), or at the limit of versions (attachment_versions_limit).',
    })
    @ApiPreconditionFailedResponse({
      description: 'It changed since you read it (precondition_failed).',
    })
    @ApiPayloadTooLargeResponse({
      description: 'Larger than ATTACHMENT_MAX_MB (payload_too_large).',
    })
    @ApiUnsupportedMediaTypeResponse({
      description:
        'A type not allowed, or not the one declared (unsupported_media_type).',
    })
    async replace(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
      @UploadedFile() file: StoredUpload | undefined,
      @Body({ schema: attachmentVersionNoteSchema })
      body: { note?: string },
      @Headers('if-match') ifMatch: string | undefined,
      @Ip() ip: string,
    ) {
      if (!file) {
        throw new BadRequestException('Attach the file as the "file" field.');
      }
      return this.versions.replace(
        user,
        { subject, recordId: id },
        attachmentId,
        file,
        { ifMatch, note: body.note, ip },
      );
    }

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
      description: `After the PUT to the URL of \`POST …/attachments/presign\`, or after the last chunk of a resumable session (\`POST …/attachments/sessions\`; any storage driver): the server reads the object back (its size and type from the store, its first bytes for the type the bytes say, never the client's word), deletes it if it is not what was announced, and otherwise attaches it exactly as an upload through the API does (\`attachment.added\`, the quota, the malware scan, the image renditions). Only the one who announced the upload may complete it.`,
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
        'A signed-URL upload on a server with a local disk (presigned_uploads_unavailable).',
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

    @Post(':id/attachments/sessions')
    @ApiOperation({
      summary: `Start a resumable upload of a file to ${aNounOf(spec)}`,
      description: `For large files and flaky connections, on every storage driver: who may change the ${noun} (${subject}.update). Send the file's name, size and type; the same checks as \`…/presign\` (size, type, the tenant's storage quota, at most 100 open uploads). Answer a session to send the file to in chunks (\`PUT …/attachments/sessions/{uploadId}?offset=\`), then \`POST …/attachments/complete\` with its \`uploadId\`. Nothing is attached, listed or downloadable until then. A session lasts 24 hours.`,
    })
    @ApiCreatedResponse({ standardSchema: uploadSessionSchema })
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
      description: 'Too many uploads open (attachment_uploads_pending).',
    })
    startSession(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: attachmentPresignSchema }) body: AttachmentPresign,
    ) {
      return this.uploads.start(user, { subject, recordId: id }, body);
    }

    @Get(':id/attachments/sessions/:uploadId')
    @ApiOperation({
      summary: `Progress of a resumable upload to ${aNounOf(spec)}`,
      description:
        'How many bytes were received: continue from there after an interruption. Your own sessions only.',
    })
    @ApiOkResponse({ standardSchema: uploadSessionSchema })
    @ApiNotFoundResponse({
      description:
        'No such record, or no such open upload of yours (attachment_upload_not_found).',
    })
    sessionProgress(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('uploadId', ParseUUIDPipe) uploadId: string,
    ) {
      return this.uploads.progress(user, { subject, recordId: id }, uploadId);
    }

    @Put(':id/attachments/sessions/:uploadId')
    @ApiOperation({
      summary: `Send a chunk of a resumable upload to ${aNounOf(spec)}`,
      description:
        "The raw bytes as the body (`application/octet-stream`), at most the session's `chunkSize`, starting at `?offset=`, which must be the `received` of the last answer. A retried or parallel chunk at a stale offset is a 409 and stores nothing: read `received` and continue.",
    })
    @ApiConsumes('application/octet-stream')
    @ApiBody({ schema: { type: 'string', format: 'binary' } })
    @ApiOkResponse({ standardSchema: uploadSessionSchema })
    @ApiForbiddenResponse({ description: `You may not change the ${noun}.` })
    @ApiNotFoundResponse({
      description:
        'No such open upload of yours (attachment_upload_not_found).',
    })
    @ApiConflictResponse({
      description:
        'The offset is not the next one (attachment_upload_offset_mismatch), or the upload is being completed.',
    })
    @ApiGoneResponse({
      description: 'The session expired (attachment_upload_expired).',
    })
    @ApiPayloadTooLargeResponse({
      description: 'The chunk is larger than allowed (payload_too_large).',
    })
    sessionChunk(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('uploadId', ParseUUIDPipe) uploadId: string,
      @Query({ schema: uploadChunkQuerySchema }) query: { offset: number },
      @Req() request: Request,
    ) {
      return this.uploads.append(
        user,
        { subject, recordId: id },
        uploadId,
        query.offset,
        request,
      );
    }

    @Delete(':id/attachments/sessions/:uploadId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
      summary: `Cancel a resumable upload to ${aNounOf(spec)}`,
      description:
        'The chunks received are deleted at once. Your own sessions only.',
    })
    @ApiNoContentResponse()
    @ApiNotFoundResponse({
      description:
        'No such open upload of yours (attachment_upload_not_found).',
    })
    @ApiConflictResponse({
      description:
        'The upload is being completed (attachment_upload_in_progress).',
    })
    async cancelSession(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('uploadId', ParseUUIDPipe) uploadId: string,
    ) {
      await this.uploads.cancel(user, { subject, recordId: id }, uploadId);
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
