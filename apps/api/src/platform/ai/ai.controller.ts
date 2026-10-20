import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { minutes } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import {
  type AiRequest,
  aiQueuedSchema,
  aiRequestSchema,
  aiRunSchema,
} from './ai.schemas.js';
import { AiService } from './ai.service.js';

/**
 * The AI helper: asking is a request that answers 202 at once; a worker
 * calls the provider with the record's fields the caller may read, and the
 * answer is read here (the requester only).
 */
@ApiTags('ai')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Checked by the service: the record's source decides who may use the helper on it.
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  // Each one is a paid call: 20 a minute per user (API clients have their quotas).
  @UserThrottle({ limit: 20, ttl: minutes(1) })
  @ApiOperation({
    summary: 'Ask the AI helper about a record',
    description:
      "Whoever may use the helper on the record (its source decides). Answers at once with the run id; a worker sends the record's fields you may read to the provider and keeps a structured answer for an hour. Follow it at GET /v1/ai/runs/{id}; your realtime connection hears `ai.ready { id, subject, recordId, task }` or `ai.failed { id, subject, recordId, error }`. Off until the tenant sets `ai.enabled`. Audited (ai.requested, ai.completed).",
  })
  @ApiAcceptedResponse({ standardSchema: aiQueuedSchema })
  @ApiForbiddenResponse({
    description:
      'You may not use it on this record, or the tenant has not turned it on (ai_disabled).',
  })
  @ApiNotFoundResponse({ description: 'No such kind of record.' })
  @ApiConflictResponse({
    description:
      'Yours is still running for this record and task (ai_pending).',
  })
  @ApiTooManyRequestsResponse({
    description:
      "More than 20 a minute from one user (rate_limited), or the tenant's daily token quota is used up (ai_quota_exceeded).",
  })
  @ApiServiceUnavailableResponse({
    description: 'The helper is not set up on this server (ai_unavailable).',
  })
  request(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: aiRequestSchema }) body: AiRequest,
    @Ip() ip: string,
  ) {
    return this.ai.request(user, body, ip);
  }

  @Get('runs/:id')
  @ApiOperation({
    summary: 'A run you asked for: its state, then the answer',
    description:
      "Only the principal who asked. `completed`: `output` is the answer in the task's shape (kept an hour, then null), with the model id and prompt version that produced it and the tokens used.",
  })
  @ApiOkResponse({ standardSchema: aiRunSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.status(user, id);
  }
}
