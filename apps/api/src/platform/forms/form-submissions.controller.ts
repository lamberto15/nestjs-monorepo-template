import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { Idempotent } from '@nestjs/idempotency';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { minutes } from '@nestjs/throttler';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { idempotencyKeyHeader } from '../idempotency/idempotency.openapi.js';
import { principalScope } from '../idempotency/idempotency.scopes.js';
import { RequireFlag } from '../settings/require-flag.js';
import { FORMS_ENABLED } from './form-settings.js';
import { FORM_SUBMISSION_LIST } from './form.list.js';
import { FormPolicy } from './form.policy.js';
import {
  formSubmissionSchema,
  type SubmitFormDto,
  submitFormSchema,
} from './form.schemas.js';
import { FormSubmissionsService } from './form-submissions.service.js';

/**
 * Answers to published forms. Submitting takes `Form.submit`; reading
 * every submission `Form.readResponses`, a submitter reads their own.
 */
@ApiTags('forms')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@RequireFlag(FORMS_ENABLED)
@Controller('forms/:formId/submissions')
export class FormSubmissionsController {
  constructor(private readonly submissions: FormSubmissionsService) {}

  @Post()
  @Can(FormPolicy, 'submit')
  // A retry with the same key gets the first submission back, not a second one.
  @Idempotent({ scope: principalScope })
  @UserThrottle({ limit: 30, ttl: minutes(1) })
  @ApiOperation({
    summary: 'Submit answers',
    description:
      "Checked on the server against the published version `versionId` names, never against what the client shows: only that version's keys, each of its type and limits, required ones present; text trimmed, defaults filled in. Stored with that version for good. Audited (`form.submitted`, never the answers). 30 a minute per user.",
  })
  @ApiHeader(idempotencyKeyHeader(true))
  @ApiCreatedResponse({ standardSchema: formSubmissionSchema })
  @ApiBadRequestResponse({
    description:
      'An answer is refused, at its path (`answers.<key>`, `answers.<key>.<index>`): unknown key, wrong type, out of range, a required one missing; `versionId` not a version of the form; the answers over 64 KiB (validation_failed). Or the Idempotency-Key is missing.',
  })
  @ApiConflictResponse({
    description:
      'Another version was published since (form_version_outdated, with the current `versionId`); or a request with this Idempotency-Key is still running.',
  })
  @ApiNotFoundResponse({
    description: 'No such form open to submissions (unpublished, archived).',
  })
  @ApiUnprocessableEntityResponse({
    description: 'This Idempotency-Key was used for a different request.',
  })
  @ApiTooManyRequestsResponse({
    description: 'More than 30 a minute from one user (rate_limited).',
  })
  submit(
    @CurrentUser() user: RequestPrincipal,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body({ schema: submitFormSchema }) dto: SubmitFormDto,
    @Ip() ip: string,
  ) {
    return this.submissions.submit(user, formId, dto, ip);
  }

  @Get()
  @Can.Anyone() // Checked by the service: every one, or the caller's own.
  @ApiOperation({
    summary: "A form's submissions",
    description:
      "Everyone's with `Form.readResponses`, else your own (`Form.submit`). `?versionId=`, `?submittedBy=`, `?createdAt.gte=`; newest first, cursor pages. Never filtered by answers.",
  })
  @ApiOkResponse({ standardSchema: pageSchema(formSubmissionSchema) })
  @ApiNotFoundResponse()
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Query({ schema: FORM_SUBMISSION_LIST.schema }) query: ListQuery,
  ) {
    return FORM_SUBMISSION_LIST.pick(
      await this.submissions.page(user, formId, query),
      query,
    );
  }

  @Get(':id')
  @Can.Anyone() // Checked by the service.
  @ApiOperation({
    summary: 'One submission, with its answers',
    description:
      'Its `version`: read that definition at GET /forms/{formId}/versions/{version}.',
  })
  @ApiOkResponse({ standardSchema: formSubmissionSchema })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.submissions.get(user, formId, id);
  }
}
