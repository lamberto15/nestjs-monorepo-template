import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import {
  assertUnchanged,
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../core/http/etag.js';
import { ApiListQuery } from '../../core/http/list-docs.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { APPROVAL_LIST, approvalList } from './approval.list.js';
import {
  approvalDetailSchema,
  approvalSchema,
  approveSchema,
  cancelSchema,
  type DecisionDto,
  rejectSchema,
  resubmitSchema,
} from './approval.schemas.js';
import { ApprovalsService } from './approvals.service.js';

/** The errors every decision route answers. */
const DecisionErrors = () =>
  applyDecorators(
    ApiForbiddenResponse({
      description:
        'Not an approver of the current stage, nor standing in for one (approval_not_assignee), or your own request (approval_self_approval).',
    }),
    ApiNotFoundResponse({ description: 'No such request that you may read.' }),
    ApiConflictResponse({
      description:
        'The stage was decided by someone else, or you decided otherwise (approval_already_decided); the request has ended (approval_closed).',
    }),
    ApiPreconditionFailedResponse({
      description:
        'The request changed since you read it (precondition_failed).',
    }),
  );

/**
 * Approval requests: the inbox, one request, and the decisions on it.
 * Taking part needs no permission: the routes answer for the requests you
 * made or are assigned to (Approval.read shows the others).
 */
@ApiTags('approvals')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @Etag()
  @Can.Anyone() // Filtered in the query: what you take part in, or may oversee.
  @ApiOperation({
    summary: 'Approval requests: your inbox, and what you asked for',
    description:
      '`?assignedToMe=true` is what waits for your decision now (yours, and those of people you stand in for); `?requestedByMe=true` what you asked for. Filter by `status`, `subject`, `action`, `recordId`, `dueAt`; newest first, cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(approvalSchema) })
  @ApiListQuery(APPROVAL_LIST)
  async list(
    @CurrentUser() user: Principal,
    @Query() raw: Record<string, unknown>,
  ) {
    // The list bound to the caller: assignedToMe and requestedByMe are theirs.
    const list = approvalList(user);
    const query = list.parse(raw);
    return list.pick(
      await this.approvals.page(user, query, list.where(query)),
      query,
    );
  }

  @Get(':id')
  @Etag()
  @Can.Anyone() // Checked by the service: a 404 for a request you may not read.
  @ApiOperation({
    summary: 'One request: its stages, assignments, decisions and timeline',
    description:
      '`can` says what you may do with it now. With an ETag: send it as If-Match on a decision to be refused (412) if it changed since you read it.',
  })
  @ApiHeader(ifNoneMatchHeader())
  @ApiOkResponse({ standardSchema: approvalDetailSchema })
  @ApiNotFoundResponse()
  get(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.detail(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @Can.Anyone() // Being assigned (or standing in) is the permission.
  @ApiOperation({
    summary: 'Approve',
    description:
      'As an approver of the current stage, or as the delegate of one (the decision is recorded as yours, on behalf of them). Approving again changes nothing.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: approvalDetailSchema })
  @DecisionErrors()
  approve(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: approveSchema }) dto: DecisionDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.decide(user, id, 'approved', dto, ifMatch, ip);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Reject (with a comment saying why)',
    description:
      'Ends the request as rejected, in every stage mode but a quorum that can still be reached.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: approvalDetailSchema })
  @ApiBadRequestResponse({ description: 'No comment (validation_failed).' })
  @DecisionErrors()
  reject(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: rejectSchema }) dto: z.infer<typeof rejectSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.decide(user, id, 'rejected', dto, ifMatch, ip);
  }

  @Post(':id/request-changes')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Send it back for changes (with a comment saying which)',
    description:
      'The requester may change the record, then resubmit (POST /v1/approvals/{id}/resubmit): a new round from the first stage.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: approvalDetailSchema })
  @ApiBadRequestResponse({ description: 'No comment (validation_failed).' })
  @DecisionErrors()
  requestChanges(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: rejectSchema }) dto: z.infer<typeof rejectSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.decide(user, id, 'changes_requested', dto, ifMatch, ip);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @Can.Anyone() // The requester, or Approval.cancel: checked by the service.
  @ApiOperation({
    summary: 'Withdraw a request',
    description:
      'The requester, or someone who may cancel approvals (Approval.cancel). The approvers still waiting are told.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: approvalDetailSchema })
  @ApiForbiddenResponse({
    description: 'Neither the requester nor allowed to cancel it.',
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'It has ended (approval_closed).' })
  @ApiPreconditionFailedResponse({ description: 'precondition_failed.' })
  async cancel(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: cancelSchema }) dto: z.infer<typeof cancelSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    // If-Match is checked under the request's lock (a check before it would race).
    return this.approvals.cancel(
      user,
      id,
      dto.reason,
      ip,
      ifMatch ? (shown: object) => assertUnchanged(ifMatch, shown) : undefined,
    );
  }

  @Post(':id/abandon')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @Can.Anyone() // Approval.manage on the request: checked by the service.
  @ApiOperation({
    summary: 'Abandon an approved request whose outcome would not apply',
    description:
      "For administrators (Approval.manage): an approved request whose workflow ended without applying it ends as failed (`abandoned`), so its record isn't locked any more, and `onFailed` runs. Refused while the workflow still runs or retries. Audited; the requester is told.",
  })
  @ApiOkResponse({ standardSchema: approvalDetailSchema })
  @ApiForbiddenResponse({
    description: 'Not allowed to manage approvals, or impersonating.',
  })
  @ApiNotFoundResponse()
  @ApiHeader(ifMatchHeader())
  @ApiConflictResponse({
    description:
      'Not approved, applied already, or its workflow still runs or retries (approval_not_stuck).',
  })
  @ApiPreconditionFailedResponse({ description: 'precondition_failed.' })
  abandon(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: cancelSchema }) dto: z.infer<typeof cancelSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.approvals.abandon(
      user,
      id,
      dto.reason,
      ip,
      ifMatch ? (shown: object) => assertUnchanged(ifMatch, shown) : undefined,
    );
  }

  @Post(':id/resubmit')
  @HttpCode(HttpStatus.OK)
  @Etag()
  @Can.Anyone() // The requester: checked by the service.
  @ApiOperation({
    summary: 'Resubmit after changes were requested',
    description:
      "The same request, a new round: from the first stage, its approvers resolved again, under the policy version it started with. `payload` replaces the proposed change (checked by the action's schema).",
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: approvalDetailSchema })
  @ApiBadRequestResponse({
    description: 'The payload fails the action’s schema.',
  })
  @ApiForbiddenResponse({ description: 'Not the requester.' })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: 'Not sent back for changes (approval_not_changes_requested).',
  })
  @ApiUnprocessableEntityResponse({
    description: 'A stage would find no approver (approval_no_approvers).',
  })
  @ApiPreconditionFailedResponse({ description: 'precondition_failed.' })
  async resubmit(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: resubmitSchema }) dto: z.infer<typeof resubmitSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.approvals.resubmit(
      user,
      id,
      dto,
      ip,
      ifMatch ? (shown: object) => assertUnchanged(ifMatch, shown) : undefined,
    );
  }

  private async decide(
    user: Principal,
    id: string,
    decision: 'approved' | 'rejected' | 'changes_requested',
    dto: DecisionDto,
    ifMatch: string | undefined,
    ip: string,
  ) {
    return this.approvals.decide(
      user,
      id,
      decision,
      dto,
      ip,
      ifMatch ? (shown: object) => assertUnchanged(ifMatch, shown) : undefined,
    );
  }
}
