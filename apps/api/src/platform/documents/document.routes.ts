import {
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { I18nContext } from '@nestjs/i18n';
import { minutes } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import { RecordIdempotent } from '../records/record-idempotency.js';
import {
  aNounOf,
  namedController,
  RecordController,
  type RecordRouteSpec,
  type RouteDocs,
} from '../records/record-routes.js';
import { DOCUMENT_LIST } from './document.list.js';
import {
  DOCUMENT_LANGUAGES,
  documentQueuedSchema,
  recordDocumentPageSchema,
} from './document.schemas.js';
import { DocumentsService } from './documents.service.js';

export interface DocumentRouteOptions {
  /** The feature's DocumentSource (`name`): `note`. */
  source: string;
  /** The feature's words for what the PDF holds. */
  docs?: { pdf?: RouteDocs };
}

/**
 * `POST /<path>/{id}/pdf`: a record as a PDF, asked for here, rendered by a
 * worker from the feature's DocumentSource, followed at /v1/documents/{id};
 * `GET /<path>/{id}/documents`: the record's documents, in progress and
 * issued.
 */
export function documentRoutes(
  spec: RecordRouteSpec,
  options: DocumentRouteOptions,
): Type {
  const { noun, subject } = spec;
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
    @RecordIdempotent(spec)
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
    @ApiQuery({
      name: 'lang',
      required: false,
      enum: DOCUMENT_LANGUAGES,
      description:
        "The document's language (else `X-Lang`, your saved language, `Accept-Language`, the server's first). A language the server doesn't answer in (LOCALES: `documentTemplates` in GET /v1/lists/{subject} lists them) falls back to the next of those.",
    })
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

    @Get(':id/documents')
    @ApiOperation({
      summary: `${a.replace(/^a/, 'A')}'s documents, newest first`,
      description: `Whoever may read the ${noun}: the documents asked for (POST …/{id}/pdf, by anyone), queued and rendering ones too, with their template, language and who asked. A completed one's \`attachmentId\` is its PDF (GET /v1/attachments/{id}/download; \`?inline=true\` shows it in the browser); downloading it takes the right to read every field it shows. Realtime: \`document.ready\` and \`document.failed\` reach the requester; \`record.attachments.changed\` the ${noun}'s watchers once one is issued.`,
    })
    @ApiOkResponse({ standardSchema: recordDocumentPageSchema })
    @ApiNotFoundResponse()
    async documentList(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query({ schema: DOCUMENT_LIST.schema }) query: ListQuery,
    ) {
      return DOCUMENT_LIST.pick(
        await this.documents.list(user, { subject, recordId: id }, query),
        query,
      );
    }
  }
  return namedController(
    DocumentRoutes,
    `${spec.className}DocumentsController`,
  );
}
