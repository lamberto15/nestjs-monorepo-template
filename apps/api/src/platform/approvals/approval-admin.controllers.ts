import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  assertUnchanged,
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../core/http/etag.js';
import { listSchema } from '../../core/http/pagination.js';
import type { Principal, UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { ApprovalDelegationsService } from './approval-delegations.service.js';
import { ApprovalPoliciesService } from './approval-policies.service.js';
import { ApprovalAccessPolicy } from './approval.policy.js';
import {
  createDelegationSchema,
  type CreateDelegationDto,
  delegationSchema,
  policyInputSchema,
  policyTypesSchema,
  policyViewSchema,
} from './approval.schemas.js';
import { ApprovalsRegistry } from './approvals.registry.js';

/**
 * Out of office: who decides your approvals while you are away. Users
 * only. Registered before ApprovalsController, so `/approvals/delegations`
 * is never read as a request id.
 */
@ApiTags('approvals')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session or user token.' })
@UserOnly()
@Controller('approvals/delegations')
export class ApprovalDelegationsController {
  constructor(private readonly delegations: ApprovalDelegationsService) {}

  @Get()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Your delegations: those you gave, and those you hold',
  })
  @ApiOkResponse({ standardSchema: listSchema(delegationSchema) })
  list(@CurrentUser() user: UserPrincipal) {
    return this.delegations.list(user);
  }

  @Post()
  @Can.Anyone()
  @ApiOperation({
    summary: 'Let someone decide your approvals for a while',
    description:
      'Between `startsAt` and `endsAt`, `toUserId` may decide the approvals assigned to you (of every subject, or of `subject`): the decision is recorded as theirs, on behalf of you. You may still decide yourself. Audited.',
  })
  @ApiCreatedResponse({ standardSchema: delegationSchema })
  @ApiBadRequestResponse({
    description:
      'Yourself, an unknown or inactive user, or a period that ends before it starts (validation_failed).',
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createDelegationSchema }) dto: CreateDelegationDto,
    @Ip() ip: string,
  ) {
    return this.delegations.create(user, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Can.Anyone()
  @ApiOperation({ summary: 'End a delegation you gave' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not a delegation you gave.' })
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.delegations.remove(user, id, ip);
  }
}

/**
 * The approvable actions' policies: the code's defaults, and versions of
 * their own that administrators store (Approval.managePolicies).
 */
@ApiTags('approvals')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid session or user token.' })
@ApiForbiddenResponse({
  description: 'Changing approval policies needs Approval.managePolicies.',
})
@UserOnly()
@Controller('approvals')
export class ApprovalPoliciesController {
  constructor(
    private readonly policies: ApprovalPoliciesService,
    private readonly registry: ApprovalsRegistry,
  ) {}

  @Get('policy-types')
  @Can(ApprovalAccessPolicy, 'managePolicies')
  @ApiOperation({
    summary:
      'What policies are made of: approver rules, stage modes, conditions',
    description:
      'Each with the JSON Schema of its parameters, which sit beside `type` in a policy. Projects register their own (docs/approvals.md, "Extending").',
  })
  @ApiOkResponse({ standardSchema: policyTypesSchema })
  types() {
    return this.registry.types();
  }

  @Get('policies')
  @Can(ApprovalAccessPolicy, 'managePolicies')
  @ApiOperation({
    summary: 'The approvable actions and the policy each runs under',
  })
  @ApiOkResponse({ standardSchema: listSchema(policyViewSchema) })
  list() {
    return this.policies.list();
  }

  @Get('policies/:key')
  @Etag()
  @Can(ApprovalAccessPolicy, 'managePolicies')
  @ApiOperation({ summary: "One action's policy (`Note.publish`)" })
  @ApiHeader(ifNoneMatchHeader())
  @ApiOkResponse({ standardSchema: policyViewSchema })
  @ApiNotFoundResponse({ description: 'No approvable action has this key.' })
  get(@Param('key') key: string) {
    return this.policies.view(key);
  }

  @Put('policies/:key')
  @Etag()
  @Can(ApprovalAccessPolicy, 'managePolicies')
  @ApiOperation({
    summary: "Store a new version of an action's policy",
    description:
      'The whole policy, checked against the registered rule, mode and condition types (GET /v1/approvals/policy-types). New requests run under it; running ones keep the version they started with. Audited.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: policyViewSchema })
  @ApiBadRequestResponse({
    description:
      'An unknown type, or parameters its schema refuses (validation_failed, each error naming its path: `stages.0.approvers.1.role`).',
  })
  @ApiNotFoundResponse({ description: 'No approvable action has this key.' })
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  async set(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    // The shape here; each rule's, mode's and condition's parameters by the registry (types registered at runtime).
    @Body({ schema: policyInputSchema }) body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    // If-Match under the policy's lock: two administrators can't both win.
    return this.policies.set(
      user,
      key,
      body,
      ip,
      ifMatch ? (shown: object) => assertUnchanged(ifMatch, shown) : undefined,
    );
  }

  @Delete('policies/:key')
  @Etag()
  @Can(ApprovalAccessPolicy, 'managePolicies')
  @ApiOperation({
    summary: "Back to the code's default policy",
    description: 'Stored as a new version, so the history stays. Audited.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: policyViewSchema })
  @ApiNotFoundResponse({ description: 'No approvable action has this key.' })
  async reset(
    @CurrentUser() user: Principal,
    @Param('key') key: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.policies.set(
      user,
      key,
      null,
      ip,
      ifMatch ? (shown: object) => assertUnchanged(ifMatch, shown) : undefined,
    );
  }
}
