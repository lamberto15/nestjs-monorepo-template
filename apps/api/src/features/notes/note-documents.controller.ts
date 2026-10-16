import {
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { I18nContext } from '@nestjs/i18n';
import { Idempotent } from '@nestjs/idempotency';
import { minutes } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import { documentQueuedSchema } from '../../platform/documents/document.schemas.js';
import { DocumentsService } from '../../platform/documents/documents.service.js';
import { idempotencyKeyHeader } from '../../platform/idempotency/idempotency.openapi.js';
import { principalScope } from '../../platform/idempotency/idempotency.scopes.js';

/**
 * A note as a PDF (platform/documents, NoteDocuments): asked for here,
 * rendered by a worker, followed at /v1/documents/{id}.
 */
@ApiTags('notes')
@ApiBearerAuth('api-key')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked by DocumentsService: whoever may read the note.
@Controller('notes')
export class NoteDocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly i18n: I18nContext,
  ) {}

  @Post(':id/pdf')
  @HttpCode(HttpStatus.ACCEPTED)
  // A retry with the same key gets the first answer instead of a second document.
  @Idempotent({ required: true, scope: principalScope })
  // Each one is a Chromium render: 10 a minute per user (API clients have their quotas).
  @UserThrottle({ limit: 10, ttl: minutes(1) })
  @ApiOperation({
    summary: 'Issue a PDF of a note',
    description: [
      "Whoever may read the note. Answers at once with the document id; a worker renders the PDF in the request's language (`?lang=`, `X-Lang`, your saved language; right to left in Arabic) and your time zone, and adds it to the note's attachments (`locked`: it never changes and cannot be removed; asking again issues a new one). The text is in it only if you may read it.",
      '',
      'Follow it at GET /v1/documents/{id}; your realtime connection hears `document.ready { id, subject, recordId, attachmentId }` (download it at GET /v1/attachments/{attachmentId}/download) or `document.failed { id, subject, recordId, error }`. Audited (document.requested, document.issued).',
    ].join('\n'),
  })
  @ApiHeader(idempotencyKeyHeader(true))
  @ApiAcceptedResponse({ standardSchema: documentQueuedSchema })
  @ApiBadRequestResponse({ description: 'The Idempotency-Key is missing.' })
  @ApiForbiddenResponse({ description: 'You may not issue it.' })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      'Your document of this note, in this language, is still being rendered (document_pending: its `id` is in the problem), or a request with this Idempotency-Key is still running.',
  })
  @ApiTooManyRequestsResponse({
    description: 'More than 10 a minute from one user (rate_limited).',
  })
  @ApiUnprocessableEntityResponse({
    description: 'This Idempotency-Key was used for a different request.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'PDF documents are not set up on this server (documents_unavailable: GOTENBERG_URL is unset).',
  })
  pdf(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.documents.request(user, {
      source: 'note',
      recordId: id,
      locale: this.i18n.locale,
      ip,
    });
  }
}
