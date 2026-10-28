import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
} from '../records/record-routes.js';
import {
  createdShareSchema,
  type CreateShareDto,
  createShareSchema,
  MAX_SHARES_PER_RECORD,
  SHARE_MAX_DAYS,
  shareListSchema,
} from './share.schemas.js';
import { SharesService } from './shares.service.js';

/**
 * `GET|POST /<path>/{id}/shares`, `DELETE …/shares/{shareId}`: a record's
 * read-only links (the `share` capability, docs/sharing.md). Whoever may
 * share the record (`<Subject>.share`, and read it) lists and makes them;
 * a link's maker, or anyone who may share the record, revokes one.
 */
export function shareRoutes(spec: RecordRouteSpec): Type {
  const { subject, noun } = spec;
  const record = (recordId: string) => ({ subject, recordId });

  @ApiForbiddenResponse({ description: `You may not share the ${noun}.` })
  @ApiNotFoundResponse({ description: `No such ${noun} (or link).` })
  @RecordController(spec, `${spec.path}/:id/shares`)
  class ShareRoutes {
    constructor(private readonly shares: SharesService) {}

    @Get()
    @Can.Anyone() // Checked by SharesService: the record's `share` action.
    @ApiOperation({
      summary: `${aNounOf(spec).replace(/^a/, 'A')}'s links, newest first`,
      description:
        'Revoked and expired ones too (`active: false`); never their tokens.',
    })
    @ApiOkResponse({ standardSchema: shareListSchema })
    list(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
    ) {
      return this.shares.list(user, record(id));
    }

    @Post()
    @Can.Anyone()
    @ApiOperation({
      summary: `Share ${aNounOf(spec)} by a read-only link`,
      description: `A link that shows the chosen fields (and the files, with \`files\`) to whoever holds it, or only to \`recipientEmail\` with a mailed code, until \`expiresAt\` (within ${SHARE_MAX_DAYS} days) or until revoked. Only a person (not an API client, not while impersonating), and only fields you may read; it never shows more than you still may when it is opened. The token is in this answer only. At most ${MAX_SHARES_PER_RECORD} working links per ${noun}. Audited \`share.created\`.`,
    })
    @ApiCreatedResponse({ standardSchema: createdShareSchema })
    @ApiBadRequestResponse({
      description:
        'A field a link does not share, an expiry out of range, or too many links (validation_failed).',
    })
    create(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: createShareSchema }) dto: CreateShareDto,
      @Ip() ip: string,
    ) {
      return this.shares.create(user, record(id), dto, ip);
    }

    @Delete(':shareId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone()
    @ApiOperation({
      summary: 'Revoke a link',
      description: `It stops opening at once; a file link it gave ends within 5 minutes. Its maker, or whoever may share the ${noun}. Audited \`share.revoked\`.`,
    })
    @ApiNoContentResponse()
    async revoke(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('shareId', ParseUUIDPipe) shareId: string,
      @Ip() ip: string,
    ) {
      await this.shares.revoke(user, record(id), shareId, ip);
    }
  }
  return namedController(ShareRoutes, `${spec.className}SharesController`);
}
