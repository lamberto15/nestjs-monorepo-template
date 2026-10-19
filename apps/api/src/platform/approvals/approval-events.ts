import { WorkflowSignal } from '@nestjs/workflows';
import { z } from 'zod';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { defineNotifications } from '../notifications/notification.types.js';

/** One workflow instance per request: the request id is in the instance id. */
export const approvalWorkflowId = (requestId: string) =>
  `approval-${requestId}`;

/**
 * What a request's workflow starts with: the request, and its tenant, in
 * which every step runs (docs/tenancy.md).
 */
export interface ApprovalWorkflowInput extends TenantEnvelope {
  requestId: string;
  tenantId: string;
}

/**
 * A stage has its outcome (sent in the deciding transaction). Key:
 * `<request>:<round>:<stage>`.
 */
export const stageDecided = new WorkflowSignal<
  {
    /** `failed`: the stage can't be decided any more (too few approvers left). */
    outcome: 'approved' | 'rejected' | 'changes_requested' | 'failed';
  } & TenantEnvelope
>('approval.stage-decided');

/** The requester (or an administrator) cancelled the request. Key: the request id. */
export const requestCancelled = new WorkflowSignal<
  { by: string } & TenantEnvelope
>('approval.cancelled');

/** The requester resubmitted after changes were requested. Key: `<request>:<round before>`. */
export const requestResubmitted = new WorkflowSignal<
  { round: number } & TenantEnvelope
>('approval.resubmitted');

/**
 * The webhook events API clients may subscribe to, for the requests they
 * made (the tenant is the requesting client). `data` is
 * `{ requestId, subject, recordId, action, status }`.
 */
export const APPROVAL_EVENT_TYPES = [
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.changes-requested',
  'approval.cancelled',
  'approval.expired',
  'approval.failed',
] as const;
export type ApprovalEventType = (typeof APPROVAL_EVENT_TYPES)[number];

/** The realtime events (packages/api-client/src/realtime.ts mirrors them). */
export const APPROVAL_REALTIME = {
  /** To an approver (and their delegates): a request waits for them. */
  assigned: 'approval.assigned',
  /** To the requester and the stage's approvers: a decision, or the request ended or moved on. */
  decided: 'approval.decided',
  /**
   * To the requester and the approvers who took part in the round: an approved
   * request's outcome was applied (`outcomeAppliedAt` is set). Sent once, by
   * the attempt that set it.
   */
  applied: 'approval.applied',
} as const;

const requestData = z.object({
  requestId: z.uuid(),
  subject: z.string(),
  action: z.string(),
  title: z.string(),
});

/**
 * What approvals tell people (texts: `i18n/<locale>/notifications.json`,
 * under `approval`). The platform adds these to the features' types.
 */
export const APPROVAL_NOTIFICATIONS = defineNotifications([
  {
    // To each approver of a stage that starts (and their delegates).
    type: 'approval.requested',
    channels: { email: 'immediate', webhook: true },
    data: requestData.extend({ by: z.string(), stage: z.string() }),
  },
  {
    // To the approvers who haven't decided, when the stage's remindAfter passes.
    type: 'approval.reminder',
    channels: { email: 'immediate', webhook: true },
    data: requestData.extend({ by: z.string() }),
  },
  {
    // To the approvers an overdue stage added (escalation).
    type: 'approval.escalated',
    channels: { email: 'immediate', webhook: true },
    data: requestData.extend({ by: z.string() }),
  },
  {
    // To the requester: the last stage approved.
    type: 'approval.approved',
    channels: { email: 'immediate', webhook: true },
    data: requestData.extend({ by: z.string() }),
  },
  {
    type: 'approval.rejected',
    channels: { email: 'immediate', webhook: true },
    data: requestData.extend({ by: z.string(), comment: z.string() }),
  },
  {
    type: 'approval.changesRequested',
    channels: { email: 'immediate', webhook: true },
    data: requestData.extend({ by: z.string(), comment: z.string() }),
  },
  {
    // To the requester: nobody decided in time.
    type: 'approval.expired',
    channels: { email: 'immediate', webhook: true },
    data: requestData,
  },
  {
    // To the requester: a stage found no approver.
    type: 'approval.failed',
    channels: { email: 'immediate', webhook: true },
    data: requestData,
  },
  {
    // To the approvers still pending: the requester withdrew it.
    type: 'approval.cancelled',
    channels: { email: false, webhook: true },
    data: requestData.extend({ by: z.string() }),
  },
]);
