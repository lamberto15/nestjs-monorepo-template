import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import {
  type PresenceBodyDto,
  presenceBodySchema,
  presenceListSchema,
  PRESENCE_BEAT_SECONDS,
  PRESENCE_TTL_SECONDS,
} from './presence.schemas.js';
import { PresenceService } from './presence.service.js';

/**
 * Who is viewing or editing a record now. Anyone who may read the record
 * sees the others and announces themselves; nobody else learns it exists.
 */
@ApiTags('presence')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked per record: the caller must read it, as watching it would.
@Controller('presence')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get(':subject/:recordId')
  @ApiOperation({
    summary: 'Who is on a record now',
    description:
      "The people viewing or editing it, advisory only: saving is still guarded by the record's ETag. Leaves out whoever lost access to the record.",
  })
  @ApiOkResponse({ standardSchema: presenceListSchema })
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  list(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    return this.presence.list(user, { subject, recordId });
  }

  @Put(':subject/:recordId')
  @ApiOperation({
    summary: 'Say you are viewing or editing a record',
    description: `Beat every ${PRESENCE_BEAT_SECONDS} seconds while the page is open; you drop out ${PRESENCE_TTL_SECONDS} seconds after the last beat. Send the mode only, never what is being typed. Answers with the list, as GET does. Others on the record hear \`record.presence\` (ids only) when you arrive or change mode.`,
  })
  @ApiOkResponse({ standardSchema: presenceListSchema })
  @ApiBadRequestResponse({
    description: 'A malformed mode (validation_failed).',
  })
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  beat(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    @Body({ schema: presenceBodySchema }) body: PresenceBodyDto,
  ) {
    return this.presence.beat(user, { subject, recordId }, body.mode);
  }

  @Delete(':subject/:recordId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Say you left a record' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: 'No such record, or you may not see it.',
  })
  async leave(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    await this.presence.leave(user, { subject, recordId });
  }
}
