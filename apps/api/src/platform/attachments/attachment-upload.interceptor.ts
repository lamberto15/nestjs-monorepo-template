import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  mixin,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-node';
import { StorageDisk, uploadToDisk } from '@nestjs/storage';
import type { NodeRequest as Request } from '@nestjs/platform-node';
import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import type { PlatformEnv } from '../platform.env.js';
import {
  assertDeclaredType,
  ATTACHMENT_SAMPLE_BYTES,
  detectAttachmentType,
} from './attachment-types.js';
import { attachmentLimits } from './attachment-limits.js';
import { AttachmentsService, attachmentKey } from './attachments.service.js';

/**
 * The upload of an attachment to a record of `subject` (its id in the
 * route parameter `param`), from the multipart field `file`:
 *
 * ```ts
 * @Post(':id/attachments')
 * @UseInterceptors(AttachmentUpload('Note'))
 * ```
 *
 * First the caller's right to attach files to that record (404, 403), so
 * nothing is stored for a refused request; then multer's FileInterceptor
 * with @nestjs/storage's `uploadToDisk()`, which streams the file onto the
 * private disk: its type recognized by its bytes (415 when not allowed,
 * ATTACHMENT_ALLOWED_TYPES, or not what the client declared), its size
 * capped (413, ATTACHMENT_MAX_MB). A mixin, as FileInterceptor is: its
 * limits come from the configuration, which decorator arguments can't read.
 */
export function AttachmentUpload(
  subject: string,
  param = 'id',
): Type<NestInterceptor> {
  @Injectable()
  class AttachmentUploadInterceptor implements NestInterceptor {
    private readonly multer: NestInterceptor;

    constructor(
      config: ConfigService<PlatformEnv, true>,
      private readonly attachments: AttachmentsService,
      disk: StorageDisk,
    ) {
      const limits = attachmentLimits(config);
      const Upload = FileInterceptor('file');
      this.multer = new Upload({
        storage: uploadToDisk({
          // The disk itself, not its name: uploadToDisk() finds a disk by name
          // through Express's or Fastify's request only, not the native adapter's.
          disk,
          // Under the uploader's tenant (`tenants/<id>/…`): the request's
          // principal, authenticated before any interceptor runs.
          key: (file, req) => {
            assertDeclaredType(file.mimetype, file.contentType!);
            return attachmentKey(
              (req as unknown as { user: Principal }).user,
              file.extension,
            );
          },
          contentTypes: limits.types,
          detectContentType: detectAttachmentType,
          contentTypeSampleBytes: ATTACHMENT_SAMPLE_BYTES,
        }),
        limits: {
          fileSize: limits.maxBytes,
          files: 1,
        },
        // Browsers send file names in UTF-8; busboy would read them as latin1.
        defParamCharset: 'utf8',
      });
    }

    async intercept(context: ExecutionContext, next: CallHandler) {
      const req = context
        .switchToHttp()
        .getRequest<Request & { user: Principal }>();
      const recordId = req.params[param];
      if (!z.uuid().safeParse(recordId).success) {
        throw new BadRequestException('Validation failed (uuid is expected)');
      }
      await this.attachments.assertCanUpload(req.user, {
        subject,
        recordId: recordId as string,
      });
      return this.multer.intercept(context, next);
    }
  }
  return mixin(AttachmentUploadInterceptor);
}
