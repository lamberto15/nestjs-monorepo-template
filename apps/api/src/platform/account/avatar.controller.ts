import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Ip,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { StoredUpload } from '@nestjs/storage';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { notWhileImpersonating } from '../../iam/account/account.schemas.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { avatarResultSchema } from './account.schemas.js';
import { AvatarUploadInterceptor } from './avatar-upload.interceptor.js';
import { AvatarService } from './avatar.service.js';

/**
 * The person's own picture. Users only, never while impersonating (the
 * picture is the account's, and an administrator acting as someone is not
 * them).
 */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'Not signed in as a user.' })
@UserOnly()
@Can.Anyone()
@Controller('account/avatar')
export class AvatarController {
  constructor(private readonly avatar: AvatarService) {}

  @Put()
  @UseInterceptors(AvatarUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Set your picture',
    description:
      'Multipart, the field `file`: a PNG, JPEG, WebP or GIF, recognized from its bytes (not the name or the declared type), at most AVATAR_MAX_MB (2). Replaces the one you had. The answer is the `avatarUrl` to show it by (also on GET /v1/auth/me and GET /v1/people). Audited (account.avatar-changed). Never while acting as another user.',
  })
  @ApiOkResponse({ standardSchema: avatarResultSchema })
  @ApiBadRequestResponse({ description: 'No file (validation_failed).' })
  @ApiForbiddenResponse({ description: 'Acting as another user.' })
  @ApiPayloadTooLargeResponse({
    description: 'Larger than AVATAR_MAX_MB (payload_too_large).',
  })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'Not a PNG, JPEG, WebP or GIF, or not the type declared (unsupported_media_type).',
  })
  set(
    @CurrentUser() user: UserPrincipal,
    @UploadedFile() file: StoredUpload | undefined,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    if (!file) {
      throw new BadRequestException('Attach the picture as the "file" field.');
    }
    return this.avatar.set(user, file, ip);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove your picture',
    description:
      'The file goes too. Without a picture, nothing happens. Audited (account.avatar-removed). Never while acting as another user.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'Acting as another user.' })
  async remove(@CurrentUser() user: UserPrincipal, @Ip() ip: string) {
    notWhileImpersonating(user);
    await this.avatar.remove(user, ip);
  }
}
