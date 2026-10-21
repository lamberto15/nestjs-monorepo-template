import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Header,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { StoredUpload } from '@nestjs/storage';
import { z } from 'zod';
import { AccessPolicy } from '../../iam/access/policies.js';
import type { Principal } from '../../iam/auth/principal.js';
import { BrandingLogoUpload } from './branding-logo-upload.interceptor.js';
import {
  brandingSchema,
  updateBrandingSchema,
  type UpdateBranding,
} from './branding.schemas.js';
import { BrandingService, LOGO_TYPES } from './branding.service.js';
import { FILE_CSP } from '../storage/files.controller.js';

const logoUploadSchema = z.object({
  file: z.unknown().optional().meta({
    type: 'string',
    format: 'binary',
    description:
      'Required. A PNG, JPEG or WebP image of at most 512 KB, recognized by its bytes.',
  }),
});

/**
 * The tenant's branding: colour, mail sender name and logo
 * (docs/branding.md). Reading is for everyone signed in (the web app
 * themes itself from it); changing it is for who manages settings, unless
 * the operators locked it.
 */
@ApiTags('branding')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'The branding of your tenant',
    description:
      'The brand colour (`#rrggbb`), the name mail is sent under, the logo’s path, whether the operators locked it and whether you may change it.',
  })
  @ApiOkResponse({ standardSchema: brandingSchema })
  get(@CurrentUser() user: Principal) {
    return this.branding.view(user);
  }

  @Put()
  @Can(AccessPolicy, 'manageSettings')
  @ApiOperation({
    summary: 'Change the branding of your tenant',
    description:
      'Who manages settings. Sets the colour and the sender name (the settings `branding.primaryColor` and `branding.mailFromName`, so audited as `setting.updated`): `null` removes one, an absent key stays. The colour is `#rrggbb` only. Answers 409 `branding_locked` while the operators have it locked.',
  })
  @ApiOkResponse({ standardSchema: brandingSchema })
  @ApiConflictResponse({
    description: 'Locked by the operators (branding_locked).',
  })
  update(
    @CurrentUser() user: Principal,
    @Body({ schema: updateBrandingSchema }) body: UpdateBranding,
    @Ip() ip: string,
  ) {
    return this.branding.update(user, body, ip);
  }

  @Post('logo')
  @Can(AccessPolicy, 'manageSettings')
  @UseInterceptors(BrandingLogoUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Set the logo of your tenant',
    description:
      'Who manages settings. Multipart, the field `file`: a PNG, JPEG or WebP of at most 512 KB, recognized by its bytes (never SVG). Replaces the logo. Audited (`branding.logo-changed`). 409 `branding_locked` while locked.',
  })
  @ApiCreatedResponse({ standardSchema: brandingSchema })
  @ApiConflictResponse({
    description: 'Locked by the operators (branding_locked).',
  })
  @ApiPayloadTooLargeResponse({
    description: 'Larger than 512 KB (payload_too_large).',
  })
  @ApiUnsupportedMediaTypeResponse({
    description: 'Not a PNG, JPEG or WebP (unsupported_media_type).',
  })
  upload(
    @CurrentUser() user: Principal,
    @UploadedFile() file: StoredUpload | undefined,
    @Body({ schema: logoUploadSchema }) _body: unknown,
    @Ip() ip: string,
  ) {
    if (!file) {
      throw new BadRequestException('Send the image as the "file" field.');
    }
    return this.branding.logoUploaded(user, file, ip);
  }

  @Delete('logo')
  @Can(AccessPolicy, 'manageSettings')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove the logo of your tenant',
    description:
      'Who manages settings. The file goes too. Audited (`branding.logo-removed`). 409 `branding_locked` while locked.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'There is no logo.' })
  @ApiConflictResponse({
    description: 'Locked by the operators (branding_locked).',
  })
  async remove(@CurrentUser() user: Principal, @Ip() ip: string) {
    await this.branding.removeLogo(user, ip);
  }
}

/**
 * A tenant's logo, without a sign-in: mail clients and the sign-in page
 * show it. A logo is a public asset (it is in every mail the tenant sends);
 * it names its tenant by id, which is not a secret either, and nothing else
 * of the tenant is reachable from here.
 */
@ApiTags('branding')
@Public()
@Controller('branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get(':tenantId/logo')
  @ApiOperation({
    summary: 'The logo of a tenant',
    description:
      "No sign-in needed. The image itself (PNG, JPEG or WebP, the type its bytes say), cached for five minutes, with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cross-Origin-Resource-Policy: cross-origin` (other sites' mail pages and apps may show it).",
  })
  @ApiProduces(...LOGO_TYPES)
  @ApiOkResponse({ description: 'The image.' })
  @ApiNotFoundResponse({ description: 'The tenant has no logo.' })
  // An image is never a page: nothing loads, nothing runs, whatever the
  // bytes hold; the policy replaces the API's own (Swagger UI's).
  @Header('Content-Security-Policy', FILE_CSP)
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=300')
  async logo(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    const file = await this.branding.logoFile(tenantId);
    if (!file) {
      throw new NotFoundException('There is no logo.');
    }
    return new StreamableFile(file.body, {
      type: file.contentType,
      length: file.size,
      disposition: 'inline',
    });
  }
}
