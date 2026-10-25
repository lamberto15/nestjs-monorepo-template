import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  mixin,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { uploadToDisk } from '@nestjs/storage';
import type { Request } from 'express';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { SettingsService } from '../settings/settings.service.js';
import { transferKey, principalTenant } from './data-transfer.service.js';
import { CONTENT_TYPES, detectTextFormat } from './formats.js';
import { importLimits } from './import-limits.js';

/** Multer's limit is selected after authentication but before it parses the upload. */
@Injectable()
class ImportUploadInterceptor implements NestInterceptor {
  constructor(
    private readonly settings: SettingsService,
    private readonly config: ConfigService<CoreEnv, true>,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user: RequestPrincipal }>();
    const limits = await importLimits(this.settings, this.config, request.user);
    (request as typeof request & { importLimits: typeof limits }).importLimits =
      limits;
    // The interceptor's Multer instance is constructed per request so its
    // fileSize limit reflects the tenant setting before the body is stored.
    const Upload = FileInterceptor('file');
    const upload = new Upload({
      storage: uploadToDisk({
        key: (_file, req) =>
          transferKey(
            principalTenant((req as Request & { user: RequestPrincipal }).user),
            `uploads/${randomUUID()}`,
          ),
        contentTypes: [
          CONTENT_TYPES.csv,
          CONTENT_TYPES.json,
          'application/zip',
          CONTENT_TYPES.xlsx,
        ],
        detectContentType: detectTextFormat,
      }),
      limits: { fileSize: limits.maxBytes, files: 1 },
    });
    return upload.intercept(context, next);
  }
}

export const ImportUpload = (): Type<NestInterceptor> =>
  mixin(ImportUploadInterceptor);
