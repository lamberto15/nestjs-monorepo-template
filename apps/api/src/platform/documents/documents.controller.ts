import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import { documentSchema } from './document.schemas.js';
import { DocumentsService } from './documents.service.js';

/**
 * The documents a feature's route asked for (`POST /v1/notes/{id}/pdf`):
 * their state, then the issued PDF's attachment id. Asking is on the
 * record's own route, which the feature adds.
 */
@ApiTags('documents')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked by the service: whoever may read the record.
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'A document asked for: its state, then the issued PDF',
    description:
      "Whoever may read its record. `completed`: `attachmentId` is the PDF (GET /v1/attachments/{id}/download). The requester's realtime connection hears `document.ready { id, subject, recordId, attachmentId }` or `document.failed { id, subject, recordId, error }`.",
  })
  @ApiOkResponse({ standardSchema: documentSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documents.status(user, id);
  }
}
