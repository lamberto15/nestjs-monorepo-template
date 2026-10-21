import { parseDuration } from '@nestjs/workflows/core';
import { z } from 'zod';

/**
 * An approval policy as data: what code declares as an action's default
 * and administrators store as a version of their own
 * (`PUT /v1/approvals/policies/{key}`). JSON all through, so it can be
 * stored, versioned and copied onto each request. Approver rules, stage
 * modes and conditions are named by `type` with their parameters next to
 * it (`{ "type": "role", "role": "editor" }`); the registry checks each
 * against the registered type's schema (ApprovalsRegistry.parsePolicy).
 */

/** A duration as the workflows take it: `30m`, `8h`, `2d`, `1w`. */
export const durationSchema = z
  .string()
  .regex(/^\d+(ms|s|m|h|d|w)$/, 'a duration: 30m, 8h, 2d, 1w')
  .meta({ example: '2d' });

/** One extension's use: its `type` and its parameters beside it. */
export const typedSchema = z
  .object({ type: z.string().min(1).max(100) })
  .catchall(z.unknown());
export type Typed = z.infer<typeof typedSchema>;

const ruleList = z.array(typedSchema).min(1).max(10);

export const stageSchema = z
  .object({
    name: z.string().trim().min(1).max(100).meta({ example: 'Editor review' }),
    /** Every user any of these rules names decides the stage (the requester never does). */
    approvers: ruleList.describe(
      'Approver rules (GET /v1/approvals/policy-types): every user any of them names is assigned when the stage starts.',
    ),
    mode: typedSchema
      .default({ type: 'any' })
      .describe(
        'How the stage completes: `{ "type": "any" }` (the first decision), `{ "type": "all" }`, `{ "type": "quorum", "n": 2 }`, or a registered mode.',
      ),
    remindAfter: durationSchema
      .optional()
      .describe('Remind the approvers who have not decided after this long.'),
    dueAfter: durationSchema
      .optional()
      .describe('The stage is overdue after this long: then `onOverdue`.'),
    onOverdue: z
      .enum(['expire', 'escalate'])
      .default('expire')
      .describe(
        'expire: the request expires; escalate: the `escalateTo` approvers are added.',
      ),
    escalateTo: ruleList
      .optional()
      .describe('With `onOverdue: escalate`: the approvers added.'),
    escalationDueAfter: durationSchema
      .optional()
      .describe('After an escalation, the request expires after this long.'),
  })
  .superRefine((stage, ctx) => {
    if (stage.onOverdue === 'escalate' && !stage.escalateTo) {
      ctx.addIssue({
        code: 'custom',
        path: ['escalateTo'],
        message: 'onOverdue escalate needs escalateTo',
      });
    }
    if (stage.onOverdue === 'escalate' && !stage.dueAfter) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueAfter'],
        message: 'onOverdue escalate needs dueAfter',
      });
    }
    if (
      stage.remindAfter &&
      stage.dueAfter &&
      parseDuration(stage.remindAfter as never) >=
        parseDuration(stage.dueAfter as never)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['remindAfter'],
        message: 'remindAfter must be shorter than dueAfter',
      });
    }
  });

export const policySchema = z
  .object({
    /** Off: the action needs no approval (an administrator's switch). */
    enabled: z.boolean().default(true),
    /** Only when this condition holds is approval needed (`{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`). */
    when: typedSchema
      .nullable()
      .optional()
      .describe(
        'Approval is needed only when this condition holds: `{ "type": "payload", "path": "amount", "op": "gt", "value": 1000 }`, `all`/`any`/`not` of others, or a registered condition.',
      ),
    stages: z.array(stageSchema).min(1).max(10),
    /** How long the requester has to resubmit after changes were requested, before the request expires. */
    resubmitWithin: durationSchema.default('30d'),
  })
  .strict();

/** A policy as stored and copied onto requests (defaults filled in). */
export type ApprovalPolicy = z.output<typeof policySchema>;
/** A policy as code declares it (defaults may be left out). */
export type ApprovalPolicyInput = z.input<typeof policySchema>;

/** Milliseconds of a validated duration. */
export const millis = (duration: string) => parseDuration(duration as never);
