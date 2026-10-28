import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { minutes, Throttle } from '@nestjs/throttler';
import {
  type OpenShareDto,
  openShareSchema,
  SHARE_CODE_MINUTES,
  type ShareCodeDto,
  shareCodeSchema,
  sharedFileLinkSchema,
  sharedRecordSchema,
} from './share.schemas.js';
import { SharesService } from './shares.service.js';

/**
 * Opening a shared link (docs/sharing.md): no sign-in, the token is the
 * proof. POSTs with the token in the body, so it is in no URL (access
 * logs, proxies, `Referer`): the web page reads it from the link's
 * fragment. Every refusal of a link is the same 404 (forged, expired,
 * revoked, its record or maker gone), and each route is throttled per
 * address well below the app's default.
 */
@ApiTags('shares')
@Public()
@Controller('shared')
export class SharedController {
  constructor(private readonly shares: SharesService) {}

  @Post('open')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @ApiOperation({
    summary: 'Open a shared link',
    description:
      "No sign-in. The record's shared fields, as its maker may read them now, and its files when the link shares them. A link to a recipient needs `code` (POST /v1/shared/code mails one). Audited `share.opened`.",
  })
  @ApiOkResponse({ standardSchema: sharedRecordSchema })
  @ApiForbiddenResponse({
    description:
      'The link needs the mailed code (`share_code_required`), or the code is wrong, used up or expired (`share_code_invalid`).',
  })
  @ApiNotFoundResponse({
    description: 'The link is invalid, expired or revoked (`share_not_found`).',
  })
  open(@Body({ schema: openShareSchema }) dto: OpenShareDto, @Ip() ip: string) {
    return this.shares.open(dto, ip);
  }

  @Post('code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @ApiOperation({
    summary: "Mail a code to a shared link's recipient",
    description: `The code opens the link for ${SHARE_CODE_MINUTES} minutes, 5 tries; a new one replaces it. The same answer whether or not the link has a recipient.`,
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: 'The link is invalid, expired or revoked (`share_not_found`).',
  })
  async code(@Body({ schema: shareCodeSchema }) dto: ShareCodeDto) {
    await this.shares.sendCode(dto.token);
  }

  @Post('files/:attachmentId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @ApiOperation({
    summary: "A shared record's file",
    description:
      'A signed link to one of the files the link lists, valid for 5 minutes, handed out only while the link works. Audited `share.opened` with the file.',
  })
  @ApiOkResponse({ standardSchema: sharedFileLinkSchema })
  @ApiForbiddenResponse({ description: 'The link needs its code.' })
  @ApiNotFoundResponse({
    description: 'The link does not work, or does not share this file.',
  })
  file(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Body({ schema: openShareSchema }) dto: OpenShareDto,
    @Ip() ip: string,
  ) {
    return this.shares.fileLink(dto, attachmentId, ip);
  }
}
