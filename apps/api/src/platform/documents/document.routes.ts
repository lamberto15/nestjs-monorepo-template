import {
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
import { I18nContext } from '@nestjs/i18n';
import { Idempotent } from '@nestjs/idempotency';
import { minutes } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import { idempotencyKeyHeader } from '../idempotency/idempotency.openapi.js';
import { principalScope } from '../idempotency/idempotency.scopes.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
  type RouteDocs,
} from '../records/record-routes.js';
import { documentQueuedSchema } from './document.schemas.js';
import { DocumentsService } from './documents.service.js';

export interface DocumentRouteOptions {
  /** The feature's DocumentSource (`name`): `note`. */
  source: string;
  /** The feature's words for what the PDF holds. */
  docs?: { pdf?: RouteDocs };
}

/**
 * `POST /<path>/{id}/pdf`: a record as a PDF, asked for here, rendered by a
 * worker from the feature's DocumentSource, followed at /v1/documents/{id}.
 */
export function documentRoutes(
  spec: RecordRouteSpec,
  options: DocumentRouteOptions,
): Type {
  const { noun } = spec;
  const a = aNounOf(spec);

  @Can.Anyone() // Checked by DocumentsService: whoever may read the record.
  @RecordController(spec, spec.path)
  class DocumentRoutes {
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
      summary: options.docs?.pdf?.summary ?? `Issue a PDF of ${a}`,
      description:
        options.docs?.pdf?.description ??
        [
          `Whoever may read the ${noun}. Answers at once with the document id; a worker renders the PDF in the request's language (\`?lang=\`, \`X-Lang\`, your saved language; right to left in Arabic) and your time zone, and adds it to the ${noun}'s attachments (\`locked\`: it never changes and cannot be removed; asking again issues a new one).`,
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
      description: `Your document of this ${noun}, in this language, is still being rendered (document_pending: its \`id\` is in the problem), or a request with this Idempotency-Key is still running.`,
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
        source: options.source,
        recordId: id,
        locale: this.i18n.locale,
        ip,
      });
    }
  }
  return namedController(
    DocumentRoutes,
    `${spec.className}DocumentsController`,
  );
}
