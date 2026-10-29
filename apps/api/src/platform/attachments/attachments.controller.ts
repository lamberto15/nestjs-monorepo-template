import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiFoundResponse,
  ApiHeader,
  ApiOkResponse,
  ApiPreconditionFailedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import { Etag, ifMatchHeader } from '../../core/http/etag.js';
import { RENDITION_NAMES } from '../images/renditions.js';
import {
  attachmentRestoreSchema,
  attachmentSchema,
  attachmentVersionListSchema,
} from './attachment.schemas.js';
import { AttachmentVersionsService } from './attachment-versions.service.js';
import {
  AttachmentsService,
  DOWNLOAD_LINK_TTL,
} from './attachments.service.js';

/** `?inline=true`: a PDF shown in the browser rather than downloaded. `?rendition=`: an image's thumbnail or preview. */
const downloadQuerySchema = z.object({
  inline: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe(
      '`true`: a PDF is shown in the browser (`Content-Disposition: inline`); any other type is still a download.',
    ),
  rendition: z
    .enum(RENDITION_NAMES)
    .optional()
    .describe(
      "An image attachment's smaller copy instead of the file: `thumb` (fits in 256 × 256 pixels) or `preview` (1600 × 1600), WebP, upright, without metadata. Shown inline whatever `inline` says. 404 (`attachment_rendition_not_found`) when there is none: not an image, not made yet (`renditionStatus` `pending`), or it could not be processed.",
    ),
});
type DownloadQuery = z.infer<typeof downloadQuerySchema>;

/**
 * One attachment, whatever its record: download it, remove it. Uploading
 * and listing are on the record's own routes (`/notes/{id}/attachments`),
 * which the feature adds.
 */
@ApiTags('attachments')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked by the service: the record's own rules.
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly versions: AttachmentVersionsService,
  ) {}

  @Get(':id')
  @Etag()
  @ApiOperation({
    summary: 'An attachment',
    description:
      'Whoever may read its record. Its ETag is what `If-Match` takes to replace or restore it (`POST …/attachments/{attachmentId}/versions`, `…/versions/{version}/restore`).',
  })
  @ApiOkResponse({ standardSchema: attachmentSchema })
  @ApiNotFoundResponse()
  get(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachments.get(user, id);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: "An attachment's versions, newest first",
    description:
      'The current file (`current: true`) and the earlier ones, with who uploaded each, when, and its revision note. Whoever may read its record.',
  })
  @ApiOkResponse({ standardSchema: attachmentVersionListSchema })
  @ApiNotFoundResponse()
  listVersions(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.versions.list(user, id);
  }

  @Get(':id/versions/:version/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download one version of an attachment',
    description: `Whoever may read its record. Redirects to a signed link to that version's file, valid for ${DOWNLOAD_LINK_TTL}, as a download (never inline). The current version downloads as \`GET /v1/attachments/{id}/download\` does.`,
  })
  @ApiFoundResponse({ description: 'To the file (a signed link).' })
  @ApiNotFoundResponse({
    description:
      'No such attachment, or version (attachment_version_not_found).',
  })
  downloadVersion(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.versions.download(user, id, version);
  }

  @Post(':id/versions/:version/restore')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @ApiHeader(ifMatchHeader())
  @ApiOperation({
    summary: 'Restore an earlier version of an attachment',
    description:
      "Who may change its record. The version's bytes become the current file again as a new version (nothing is lost), scanned again like an upload. Audited (attachment.version-restored). With `If-Match` (the attachment's ETag) refused (412) if it changed since you read it.",
  })
  @ApiOkResponse({ standardSchema: attachmentSchema })
  @ApiForbiddenResponse({ description: 'You may not change its record.' })
  @ApiNotFoundResponse({
    description:
      'No such attachment, or version (attachment_version_not_found).',
  })
  @ApiConflictResponse({
    description:
      'An issued document (attachment_locked), still being scanned or processed (attachment_busy), or at the limit of versions.',
  })
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  restoreVersion(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body({ schema: attachmentRestoreSchema }) body: { note?: string },
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.versions.restore(user, id, version, {
      ifMatch,
      note: body.note,
      ip,
    });
  }

  @Get(':id/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download an attachment',
    description: `Whoever may read its record. Redirects to a signed link to the file, valid for ${DOWNLOAD_LINK_TTL}: it needs no credentials, so a browser can follow it (a link, an image). The file comes as \`Content-Disposition: attachment\` (a download), with \`X-Content-Type-Options: nosniff\`; \`?inline=true\` shows a PDF in the browser instead (a preview in a new tab), under \`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox\` (nothing loads, nothing runs, no page may frame it). Any other type stays a download. \`?rendition=thumb\` or \`preview\` links to an image's smaller WebP copy instead, inline.`,
  })
  @ApiFoundResponse({ description: 'To the file (a signed link).' })
  @ApiConflictResponse({
    description:
      'The malware scan has not finished (attachment_scan_pending): try again shortly.',
  })
  @ApiNotFoundResponse({
    description:
      'No such attachment, or with `rendition`: it has no such copy (attachment_rendition_not_found).',
  })
  download(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: downloadQuerySchema }) query: DownloadQuery,
  ) {
    return this.attachments.download(user, id, query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an attachment',
    description:
      'Your own upload, or any attachment of a record you may change (for notes: Note.update). The file is deleted too. Audited (attachment.removed). Never an issued document (`locked`).',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description:
      'An issued document (attachment_locked): it stays with its record.',
  })
  @ApiForbiddenResponse({
    description: 'Not yours, and you may not change its record.',
  })
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.attachments.remove(user, id, ip);
  }
}
