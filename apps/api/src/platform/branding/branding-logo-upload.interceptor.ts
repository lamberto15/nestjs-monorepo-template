import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-node';
import { randomUUID } from 'node:crypto';
import { StorageDisk, uploadToDisk } from '@nestjs/storage';
import type { Principal } from '../../iam/auth/principal.js';
import {
  BrandingService,
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  type LogoVariant,
} from './branding.service.js';

const Upload = FileInterceptor('file');

/**
 * The logo's upload, from the multipart field `file`. The lock is checked
 * first (409), so a refused request stores nothing; then multer with
 * @nestjs/storage's `uploadToDisk()` streams the file to a new key of the
 * tenant's, after recognizing PNG, JPEG or WebP by its first bytes (415
 * for anything else, whatever the client declares, SVG and HTML included)
 * and capping its size (413). A refused or cut upload never replaces the
 * logo that is there. The dark-mode logo takes the very same checks.
 */
function logoUpload(variant: LogoVariant): Type<NestInterceptor> {
  @Injectable()
  class LogoUpload implements NestInterceptor {
    private readonly multer: NestInterceptor;

    constructor(
      @Inject(BrandingService) private readonly branding: BrandingService,
      @Inject(StorageDisk) disk: StorageDisk,
    ) {
      this.multer = new Upload({
        storage: uploadToDisk({
          // The disk itself, not its name: uploadToDisk() finds a disk by name
          // through Express's or Fastify's request only, not the native adapter's.
          disk,
          // The request's tenant (the principal's, authenticated before any
          // interceptor runs), never the client's.
          key: (_file, req) => {
            const tenantId = (
              req as unknown as { user: Principal & { tenantId: string } }
            ).user.tenantId;
            return BrandingService.logoKey(tenantId, randomUUID(), variant);
          },
          contentTypes: [...LOGO_TYPES],
        }),
        limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
      });
    }

    async intercept(context: ExecutionContext, next: CallHandler) {
      await this.branding.assertEditable(
        context.switchToHttp().getRequest<{ user: Principal }>().user,
      );
      return this.multer.intercept(context, next);
    }
  }
  return LogoUpload;
}

export const BrandingLogoUpload = logoUpload('light');
export const BrandingDarkLogoUpload = logoUpload('dark');
