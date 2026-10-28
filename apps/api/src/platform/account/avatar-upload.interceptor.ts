import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-node';
import { uploadToDisk } from '@nestjs/storage';
import { randomUUID } from 'node:crypto';
import type { NodeRequest as Request } from '@nestjs/platform-node';
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { assertDeclaredType } from '../attachments/attachment-types.js';
import type { PlatformEnv } from '../platform.env.js';
import { accountFileKey } from '../storage/storage.config.js';
import { avatarLimits } from './avatar.js';

/**
 * The upload of the signed-in user's picture, from the multipart field
 * `file`: streamed onto the private disk (`accounts/<id>/avatar/<random>.<ext>`:
 * the picture is the person's, not a tenant's), its type read from its
 * bytes (415 unless PNG, JPEG, WebP or GIF, or when it is not what the
 * client declared), its size capped (413, AVATAR_MAX_MB). Refused while
 * impersonating before anything is stored. The storage layer is the
 * attachments' (`uploadToDisk`, `assertDeclaredType`); the key and the
 * limits are the avatar's own, so a change to attachments (malware scan,
 * thumbnails) does not reach it. The limits come from the configuration
 * (AVATAR_MAX_MB), which a decorator's arguments can't read.
 */
@Injectable()
export class AvatarUploadInterceptor implements NestInterceptor {
  private readonly multer: NestInterceptor;

  constructor(config: ConfigService<PlatformEnv, true>) {
    const limits = avatarLimits(config);
    const Upload = FileInterceptor('file');
    this.multer = new Upload({
      storage: uploadToDisk({
        key: (file, req) => {
          assertDeclaredType(file.mimetype, file.contentType!);
          return accountFileKey(
            (req as unknown as { user: UserPrincipal }).user.id,
            `avatar/${randomUUID()}${file.extension}`,
          );
        },
        contentTypes: [...limits.types],
      }),
      limits: { fileSize: limits.maxBytes, files: 1 },
      defParamCharset: 'utf8',
    });
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user: UserPrincipal }>();
    notWhileImpersonating(req.user);
    return this.multer.intercept(context, next);
  }
}
