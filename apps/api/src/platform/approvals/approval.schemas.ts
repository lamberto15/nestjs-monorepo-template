import { z } from 'zod';
import { policySchema } from './approval-policy.js';
import { APPROVAL_STATUSES, ASSIGNMENT_STATUSES } from './approvals.tables.js';

/** A request for approval, as lists show it. */
export const approvalSchema = z.object({
  id: z.uuid(),
  key: z.string().describe('The action: `<subject>.<action>`, `Note.publish`.'),
  subject: z.string().meta({ example: 'Note' }),
  recordId: z.string(),
  action: z.string().meta({ example: 'publish' }),
  status: z.enum(APPROVAL_STATUSES),
  requester: z.string().describe('`user:<id>` or `client:<id>`.'),
  requesterName: z.string(),
  title: z.string().describe('What the record is called.'),
  link: z.string().nullable().describe('The record in the web app.'),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      "The proposed change; its schema is the action's `payloadSchema` (GET /v1/approvals/policies).",
    ),
  policyVersion: z
    .number()
    .int()
    .describe("The policy version it runs under (0: the code's default)."),
  round: z.number().int().describe('Resubmissions so far.'),
  currentStage: z.number().int(),
  stageCount: z.number().int(),
  stageName: z.string(),
  dueAt: z.iso.datetime().nullable().describe("The current stage's deadline."),
  comment: z.string().nullable().describe("The requester's note."),
  outcomeReason: z
    .string()
    .nullable()
    .describe(
      'Why it ended without a decision: `overdue`, `not_resubmitted`, `no_approvers`.',
    ),
  endedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ApprovalView = z.infer<typeof approvalSchema>;

export const assignmentSchema = z.object({
  id: z.uuid(),
  round: z.number().int(),
  stage: z.number().int(),
  approverId: z.uuid(),
  approverName: z.string(),
  status: z.enum(ASSIGNMENT_STATUSES),
  comment: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  decidedBy: z.uuid().nullable(),
  decidedByName: z.string().nullable(),
  onBehalfOf: z
    .uuid()
    .nullable()
    .describe('Set when a delegate decided for the approver.'),
  escalated: z.boolean(),
});

const STAGE_STATES = [
  'waiting',
  'active',
  'approved',
  'rejected',
  'changes_requested',
  'closed',
] as const;

export const approvalDetailSchema = approvalSchema.extend({
  stages: z
    .array(
      z.object({
        index: z.number().int(),
        name: z.string(),
        mode: z.record(z.string(), z.unknown()),
        state: z.enum(STAGE_STATES),
      }),
    )
    .describe("The policy's stages, as they stand in the current round."),
  assignments: z
    .array(assignmentSchema)
    .describe('Every assignment of every round, oldest first.'),
  timeline: z.array(
    z.object({
      id: z.uuid(),
      type: z.string().meta({ example: 'stage_started' }),
      actor: z
        .string()
        .nullable()
        .describe(
          "Who did it: `user:<id>`, `client:<id>`, or the system (`system:approvals`: the workflow's timers; `system:<job>`: a job that ended it). Null only on events recorded before the system principal.",
        ),
      actorName: z.string().nullable(),
      round: z.number().int(),
      stage: z.number().int().nullable(),
      details: z.record(z.string(), z.unknown()).nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  can: z
    .object({
      decide: z.boolean(),
      cancel: z.boolean(),
      resubmit: z.boolean(),
    })
    .describe('What you may do with it now.'),
});
export type ApprovalDetail = z.infer<typeof approvalDetailSchema>;

const comment = z.string().trim().min(1).max(2000);

/**
 * `POST /approvals/{id}/approve`. One person decides once per stage: the
 * decision covers their own assignment and those of the people they stand
 * in for.
 */
export const approveSchema = z.preprocess(
  (body) => body ?? {},
  z.object({ comment: comment.optional() }).strict(),
);
export type DecisionDto = { comment?: string };

/** `POST /approvals/{id}/reject` and `/request-changes`: the comment says why. */
export const rejectSchema = z.object({ comment }).strict();

export const cancelSchema = z.preprocess(
  (body) => body ?? {},
  z.object({ reason: comment.optional() }),
);

export const resubmitSchema = z.preprocess(
  (body) => body ?? {},
  z.object({
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("A new proposed change; checked by the action's schema."),
    comment: comment.optional(),
  }),
);

export const delegationSchema = z.object({
  id: z.uuid(),
  fromUserId: z.uuid(),
  fromName: z.string(),
  toUserId: z.uuid(),
  toName: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  subject: z.string().nullable(),
  active: z.boolean().describe('Whether it applies now.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createDelegationSchema = z
  .object({
    toUserId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    subject: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only requests of this subject (`Note`); all when left out.'),
  })
  .refine((body) => new Date(body.endsAt) > new Date(body.startsAt), {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt',
  });
export type CreateDelegationDto = z.infer<typeof createDelegationSchema>;

const jsonObject = z.record(z.string(), z.unknown());

export const policyViewSchema = z.object({
  key: z.string(),
  subject: z.string(),
  action: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  version: z.number().int().describe('0: the code default, never changed.'),
  source: z.enum(['code', 'override']),
  policy: policySchema,
  default: policySchema.describe("The code's default policy."),
  setting: z
    .string()
    .nullable()
    .describe('The setting that switches approval on (GET /v1/settings).'),
  payloadSchema: jsonObject.describe(
    "The JSON Schema of the requests' payload.",
  ),
});

/** `PUT /approvals/policies/{key}`: a whole policy. */
export const policyInputSchema = policySchema;

const typeView = z.object({
  type: z.string(),
  label: z.string(),
  params: jsonObject.describe('The JSON Schema of its parameters.'),
});
export const policyTypesSchema = z.object({
  approverRules: z.array(typeView),
  modes: z.array(typeView),
  conditions: z.array(typeView),
});
