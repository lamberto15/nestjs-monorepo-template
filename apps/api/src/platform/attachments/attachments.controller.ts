import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import type { Principal } from '../../iam/auth/principal.js';
import {
  AttachmentsService,
  DOWNLOAD_LINK_TTL,
} from './attachments.service.js';

/** `?inline=true`: a PDF shown in the browser rather than downloaded. */
const downloadQuerySchema = z.object({
  inline: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe(
      '`true`: a PDF is shown in the browser (`Content-Disposition: inline`); any other type is still a download.',
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
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download an attachment',
    description: `Whoever may read its record. Redirects to a signed link to the file, valid for ${DOWNLOAD_LINK_TTL}: it needs no credentials, so a browser can follow it (a link, an image). The file comes as \`Content-Disposition: attachment\` (a download), with \`X-Content-Type-Options: nosniff\`; \`?inline=true\` shows a PDF in the browser instead (a preview in a new tab), under \`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox\` (nothing loads, nothing runs, no page may frame it). Any other type stays a download.`,
  })
  @ApiFoundResponse({ description: 'To the file (a signed link).' })
  @ApiConflictResponse({
    description:
      'The malware scan has not finished (attachment_scan_pending): try again shortly.',
  })
  @ApiNotFoundResponse()
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
