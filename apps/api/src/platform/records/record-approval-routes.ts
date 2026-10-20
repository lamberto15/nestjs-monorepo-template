import { createHash } from 'node:crypto';
import {
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  type ApprovalHandler,
  type ApprovalOutcome,
} from '../approvals/approval.types.js';
import { ApprovalsRegistry } from '../approvals/approvals.registry.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { recordView, type RecordDeclaration } from './record.js';
import {
  actionClass,
  actionPath,
  type DeclaredApproval,
  type RecordApprovalEffect,
  type RecordApprovalPayload,
  recordApprovalActions,
} from './record-approvals.js';
import { RECORD_CONTRACT, type RecordContract } from './record-contract.js';
import { RecordIdempotent } from './record-idempotency.js';
import type { RecordPolicy } from './record-policy.js';
import { namedController, RecordController, aNounOf } from './record-routes.js';
import { titleOf } from './record-targets.js';

/** What an approvable action's route answers. */
export const approvalResultSchema = z
  .object({
    status: z.enum(['applied', 'pending']).meta({
      description:
        '`applied`: no approval was needed and it is done; `pending`: waiting for the approvers (follow it at GET /v1/approvals/{approvalId}).',
    }),
    approvalId: z.uuid().nullable(),
  })
  .meta({ id: 'RecordApprovalResult' });

/**
 * The platform's handler of an approvable action (record.ts `approvals`):
 * what the record is, how it is read for the approvers, and the feature's
 * effect once approved (`<item>.approvals.ts`).
 */
function handlerOf(
  declaration: RecordDeclaration,
  approved: DeclaredApproval,
  effect: RecordApprovalEffect,
): Type {
  @Injectable()
  class RecordApprovalAction implements ApprovalHandler<RecordApprovalPayload> {
    readonly approval = approved.declaration;

    constructor(
      @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
      registry: ApprovalsRegistry,
    ) {
      registry.handle(this);
    }

    /** For the `permission` rule and conditions: the record (a 404 when gone counts as none). */
    record(id: string) {
      return this.c.service.findOne(id);
    }

    async describe(id: string, { title }: RecordApprovalPayload) {
      return { title, link: `/${declaration.path}/${id}` };
    }

    /** What is approved is the record as it is (never what a caller says it is). */
    async payload(id: string): Promise<RecordApprovalPayload> {
      const row = await this.c.service.findOne(id);
      return { title: titleOf(declaration, row).slice(0, 200) };
    }

    /** The record's content, hashed: an edit that went around the lock isn't applied as approved. */
    async fingerprint(id: string) {
      try {
        const row = await this.c.service.findOne(id);
        return createHash('sha256')
          .update(JSON.stringify(recordView(declaration, row)))
          .digest('base64url');
      } catch (error) {
        if (error instanceof NotFoundException) {
          return null;
        }
        throw error;
      }
    }

    /** As the approvals workflow (`actor`, `system:approvals`): the audit's actor. */
    async onApproved({
      request,
      actor,
    }: ApprovalOutcome<RecordApprovalPayload>) {
      await effect.apply({
        id: request.recordId,
        actor,
        service: this.c.service,
      });
    }
  }
  return Object.defineProperty(RecordApprovalAction, 'name', {
    value: `${declaration.className}${actionClass(approved.action)}Approval`,
  });
}

/** The handlers of a record's approvable actions: providers of its module (recordParts). */
export function recordApprovalHandlers(
  declaration: RecordDeclaration,
  effects: Record<string, RecordApprovalEffect> = {},
): Type[] {
  return recordApprovalActions(declaration).map((approved) => {
    const effect = effects[approved.action];
    if (!effect) {
      throw new Error(
        `${declaration.subject}.${approved.action} needs approval but has no effect: add it to ${declaration.path}'s approvals (recordParts(…, { approvals })), or run pnpm feature:sync.`,
      );
    }
    return handlerOf(declaration, approved, effect);
  });
}

/**
 * `POST /<path>/{id}/<action>` for each approvable action: asks for the
 * approval the declaration says is needed, or applies the action at once
 * when it isn't. 200 `applied`, 202 `pending`. Whoever may update the
 * record may ask; the approvers decide at /v1/approvals.
 */
export function recordApprovalRoutes(
  declaration: RecordDeclaration,
  options: {
    policy: Type<RecordPolicy>;
    effects: Record<string, RecordApprovalEffect>;
  },
): Type[] {
  const a = aNounOf(declaration);
  return recordApprovalActions(declaration).map((approved) => {
    const { action } = approved;
    const effect = options.effects[action];
    const label = approved.declaration.label;

    @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
    @RecordController(declaration, declaration.path)
    class ApprovalActionRoutes {
      constructor(
        @Inject(RECORD_CONTRACT) private readonly c: RecordContract,
        private readonly authorization: AuthorizationService,
        private readonly approvals: ApprovalsService,
      ) {}

      @Post(`:id/${actionPath(action)}`)
      @HttpCode(HttpStatus.OK)
      @RecordIdempotent(declaration)
      @Can.Anyone() // Checked below, on the record itself.
      @ApiOperation({
        summary: `${label}`,
        description: `Needs the approval of ${declaration.subject}.${action}'s policy when it is on for you (GET /v1/approvals/policies/${declaration.subject}.${action}); otherwise it is done at once. While a request is open, ${a} can't be changed or deleted (409 \`approval_pending\`).`,
        operationId: `${declaration.className}${actionClass(action)}Controller_request_v1`,
      })
      @ApiOkResponse({ standardSchema: approvalResultSchema })
      @ApiAcceptedResponse({ standardSchema: approvalResultSchema })
      @ApiNotFoundResponse()
      @ApiConflictResponse({
        description: 'An approval of this action is already open.',
      })
      async request(
        @CurrentUser() user: RequestPrincipal,
        @Param('id', ParseUUIDPipe) id: string,
        @Res({ passthrough: true }) res: Response,
      ) {
        const row = await this.c.service.findOne(id);
        await this.authorization.authorize(options.policy, 'update', user, row);
        const result = await this.approvals.request(user, {
          subject: declaration.subject,
          recordId: id,
          action,
        });
        if (result.required) {
          res.status(HttpStatus.ACCEPTED);
          return { status: 'pending' as const, approvalId: result.request.id };
        }
        await effect!.apply({ id, actor: user, service: this.c.service });
        return { status: 'applied' as const, approvalId: null };
      }
    }
    return namedController(
      ApprovalActionRoutes,
      `${declaration.className}${actionClass(action)}Controller`,
    );
  });
}
