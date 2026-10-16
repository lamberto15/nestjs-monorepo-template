import { randomUUID } from 'node:crypto';
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
import { FileInterceptor } from '@nestjs/platform-express';
import { uploadToDisk } from '@nestjs/storage';
import type { Request } from 'express';
import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import type { PlatformEnv } from '../platform.env.js';
import {
  assertDeclaredType,
  ATTACHMENT_SAMPLE_BYTES,
  detectAttachmentType,
} from './attachment-types.js';
import { AttachmentsService } from './attachments.service.js';

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
    ) {
      const Upload = FileInterceptor('file');
      this.multer = new Upload({
        storage: uploadToDisk({
          key: (file) => {
            assertDeclaredType(file.mimetype, file.contentType!);
            return `attachments/${randomUUID()}${file.extension}`;
          },
          contentTypes: config.get('ATTACHMENT_ALLOWED_TYPES', {
            infer: true,
          }),
          detectContentType: detectAttachmentType,
          contentTypeSampleBytes: ATTACHMENT_SAMPLE_BYTES,
        }),
        limits: {
          fileSize:
            config.get('ATTACHMENT_MAX_MB', { infer: true }) * 1024 * 1024,
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
