import { z } from 'zod';
import { DIAGNOSTIC_CHECKS } from './ops-diagnostics.service.js';

/**
 * What the operations API answers (`ops.controller.ts`). The routes send
 * their answers through these schemas (`StandardSchemaSerializerInterceptor`
 * for the JSON routes, `opsEvent()` for the stream), so the OpenAPI document
 * and the typed client can't drift from what is sent, and a property a
 * schema doesn't declare never leaves the API (`z.object()` strips it: the
 * schema is an allowlist). Times are epoch milliseconds, as the engines keep
 * them, unless the name says otherwise.
 */

const epochMs = z.number().int();
const count = z.number().int().nonnegative();
/** A duration: the engines compute backoffs and timings as fractions of a millisecond. */
const ms = z.number().nonnegative();

// ---- GET /v1/ops/outbox ----

export const outboxStatsSchema = z.object({
  /** Messages not yet published (ready, delayed or leased). */
  pending: count,
  /** Claimable right now. */
  ready: count,
  /** Under an unexpired lease. */
  leased: count,
  deadLetters: count,
  /** Epoch ms since which the longest-waiting message has waited, or null when none is. */
  oldestDueAt: epochMs.nullable(),
  /** How long the oldest due message has waited, in ms: the number to alert on. */
  lagMs: count,
  /** Messages this relay is publishing right now. */
  inFlight: count,
});

const attemptSchema = z.object({
  attempt: count,
  at: epochMs,
  /** The failure's message, masked and cut (never a stack trace). */
  error: z.string(),
  transport: z.string().optional(),
});

export const deadLetterSchema = z.object({
  id: z.string(),
  topic: z.string(),
  key: z.string().nullable(),
  attempts: count,
  /** The last failure's message, masked and cut (never a stack trace). */
  lastError: z.string().nullable(),
  reason: z.enum(['exhausted', 'rejected']),
  createdAt: epochMs,
  failedAt: epochMs,
  history: z.array(attemptSchema),
  /** The message's payload with secrets masked, long text cut. */
  payload: z.unknown(),
  /** The message's headers with credentials masked. */
  headers: z.record(z.string(), z.string()),
});

export const outboxStateSchema = z.object({
  stats: outboxStatsSchema,
  /** The latest 50. */
  deadLetters: z.array(deadLetterSchema),
  notifications: z.object({
    /** Stored notifications the worker has not delivered, though older than ten minutes; stops at 10,000. */
    undelivered: count,
    /** True when `undelivered` stopped at 10,000 (show 10,000+). */
    undeliveredCapped: z.boolean(),
  }),
  /** Whether the caller may requeue and purge dead letters. */
  canManage: z.boolean(),
});

// ---- GET /v1/ops/queues and the actions on them ----

export const queueOverviewSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      paused: z.boolean(),
      counts: z.object({
        waiting: count,
        active: count,
        delayed: count,
        completed: count,
        failed: count,
      }),
      recentFailures: z.array(
        z.object({
          id: z.union([z.string(), z.number()]).nullable(),
          name: z.string(),
          attempts: count,
          /** The failure's message, masked and cut. */
          reason: z.string().nullable(),
          /** ISO 8601, UTC. */
          failedAt: z.iso.datetime().nullable(),
        }),
      ),
    }),
  ),
});

export const retriedSchema = z.object({ retried: count });
export const requeuedSchema = z.object({ requeued: count });
export const purgedSchema = z.object({ purged: count });

// ---- GET /v1/ops/diagnostics, POST /v1/ops/diagnostics/{check}/test ----

const diagnosticCheck = z.enum(DIAGNOSTIC_CHECKS);

export const diagnosticsSchema = z.object({
  items: z.array(
    z.object({
      check: diagnosticCheck,
      /** ok: answered now; configured: set up, not probed (run its test); disabled, unconfigured, unavailable. */
      state: z.enum([
        'ok',
        'configured',
        'disabled',
        'unconfigured',
        'unavailable',
      ]),
      /** The driver or transport's name (`smtp`, `s3`), never a URL or a credential. */
      driver: z.string().nullable(),
      /** What went wrong, masked as in the logs and cut. */
      detail: z.string().nullable(),
      /** What to do about it. */
      hint: z.string().nullable(),
      testable: z.boolean(),
    }),
  ),
  canTest: z.boolean(),
});

export const diagnosticTestSchema = z.object({
  check: diagnosticCheck,
  ok: z.boolean(),
  durationMs: count,
  detail: z.string().nullable(),
  hint: z.string().nullable(),
});

// ---- GET /v1/ops/events (Server-Sent Events) ----

/** An error as the browser sees it: the class's name and a masked, cut message. */
const errorSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
});

const base = <S extends string>(source: S) => ({
  source: z.literal(source),
  /** Epoch ms of the event. */
  at: epochMs,
});

const outboxMessageSchema = z.object({
  id: z.string(),
  topic: z.string(),
  key: z.string().nullable(),
  createdAt: epochMs,
  availableAt: epochMs,
  attempts: count,
  lastError: z.string().nullable(),
  /** Credentials masked. */
  headers: z.record(z.string(), z.string()),
  /** Secrets masked, long text cut. */
  payload: z.unknown(),
});

const webhookDeliverySchema = z.object({
  id: z.string(),
  messageId: z.string(),
  endpointId: z.string(),
  tenant: z.string().nullable(),
  type: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  attempts: count,
  nextAttemptAt: epochMs.nullable(),
  lastAttemptAt: epochMs.nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  failureReason: z
    .enum(['exhausted', 'rejected', 'endpoint-disabled', 'endpoint-deleted'])
    .nullable(),
  createdAt: epochMs,
  completedAt: epochMs.nullable(),
});

const workflowBase = (type: string) => ({
  ...base('workflow'),
  type: z.literal(type),
  /** The instance's id. */
  id: z.string(),
  workflow: z.string(),
  version: z.number().int(),
});

const workflowEventSchema = z.discriminatedUnion('type', [
  z.object(workflowBase('workflow-started')),
  z.object({ ...workflowBase('workflow-resumed'), run: count }),
  z.object({
    ...workflowBase('workflow-suspended'),
    wakeAt: epochMs.nullable(),
    waits: z.array(
      z.object({ signal: z.string(), key: z.string().nullable() }),
    ),
  }),
  z.object({ ...workflowBase('workflow-compensating'), error: errorSchema }),
  z.object({ ...workflowBase('workflow-completed'), output: z.unknown() }),
  z.object({ ...workflowBase('workflow-failed'), error: errorSchema }),
  z.object({ ...workflowBase('workflow-cancelled'), error: errorSchema }),
  z.object({
    ...workflowBase('workflow-compensation-failed'),
    error: errorSchema,
  }),
  z.object({
    ...workflowBase('step-completed'),
    step: z.string(),
    attempt: count,
    durationMs: ms,
  }),
  z.object({
    ...workflowBase('step-failed'),
    step: z.string(),
    attempt: count,
    error: errorSchema,
    retryAt: epochMs.nullable(),
  }),
  z.object({
    ...workflowBase('step-compensated'),
    step: z.string(),
    attempt: count,
  }),
  z.object({
    ...workflowBase('child-started'),
    child: z.string(),
    childWorkflow: z.string(),
    childVersion: z.number().int(),
  }),
  z.object({
    ...workflowBase('signal-received'),
    wait: z.string(),
    signal: z.string(),
    signalId: z.number().int(),
  }),
  z.object({
    ...workflowBase('signal-timed-out'),
    wait: z.string(),
    signal: z.string(),
  }),
  z.object({
    ...workflowBase('journal-large'),
    entries: count,
    bytes: count,
  }),
  z.object({ ...workflowBase('custom-status'), status: z.unknown() }),
  z.object({
    ...workflowBase('workflow-retried'),
    from: z.enum(['failed', 'compensation_failed']),
    error: errorSchema.nullable(),
  }),
  z.object({
    ...workflowBase('workflow-deleted'),
    status: z.string(),
  }),
  z.object({
    ...workflowBase('schedule-skipped'),
    reason: z.enum(['missed', 'overlap']),
    from: epochMs,
    to: epochMs,
  }),
]);

const webhooksEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base('webhooks'),
    type: z.literal('delivered'),
    delivery: webhookDeliverySchema,
    statusCode: z.number().int(),
    attempt: count,
    durationMs: ms,
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('retry-scheduled'),
    delivery: webhookDeliverySchema,
    error: errorSchema,
    statusCode: z.number().int().nullable(),
    attempt: count,
    delayMs: ms,
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('delivery-failed'),
    delivery: webhookDeliverySchema,
    error: errorSchema,
    statusCode: z.number().int().nullable(),
    attempt: count,
    reason: z.enum([
      'exhausted',
      'rejected',
      'endpoint-disabled',
      'endpoint-deleted',
    ]),
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('endpoint-disabled'),
    endpointId: z.string(),
    tenant: z.string().nullable(),
    reason: z.enum(['failing', 'gone']),
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('destination-blocked'),
    endpointId: z.string(),
    tenant: z.string().nullable(),
    reason: z.string(),
    address: z.string().optional(),
  }),
  z.object({
    ...base('webhooks'),
    type: z.literal('verification-failed'),
    receiver: z.string(),
    reason: z.string(),
  }),
]);

const outboxReason = z.enum(['exhausted', 'rejected']);

const outboxEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base('outbox'),
    type: z.literal('published'),
    message: outboxMessageSchema,
    transport: z.string(),
    durationMs: ms,
  }),
  z.object({
    ...base('outbox'),
    type: z.literal('retry-scheduled'),
    message: outboxMessageSchema,
    transport: z.string().optional(),
    error: errorSchema,
    attempt: count,
    delayMs: ms,
  }),
  z.object({
    ...base('outbox'),
    type: z.literal('dead-lettered'),
    message: outboxMessageSchema,
    transport: z.string().optional(),
    error: errorSchema,
    attempt: count,
    reason: outboxReason,
  }),
  z.object({
    ...base('outbox'),
    type: z.literal('lease-lost'),
    message: outboxMessageSchema,
  }),
]);

const idempotencyBase = {
  ...base('idempotency'),
  context: z.enum(['http', 'graphql', 'rpc']),
  handler: z.string(),
  scope: z.string().optional(),
};

const idempotencyEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...idempotencyBase,
    type: z.literal('replayed'),
    key: z.string(),
    status: z.number().int(),
  }),
  z.object({
    ...idempotencyBase,
    type: z.literal('rejected'),
    key: z.string().optional(),
    code: z.string(),
    status: z.number().int(),
  }),
  z.object({
    ...idempotencyBase,
    type: z.literal('lock-lost'),
    key: z.string(),
    phase: z.enum(['extend', 'complete', 'release']),
  }),
]);

const locksEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base('locks'),
    type: z.literal('lock-lost'),
    key: z.string(),
    fencingToken: z.number().int(),
    detectedBy: z.enum(['renewal', 'deadline']),
  }),
  z.object({
    ...base('locks'),
    type: z.literal('leadership-acquired'),
    key: z.string(),
    fencingToken: z.number().int(),
  }),
  z.object({
    ...base('locks'),
    type: z.literal('leadership-lost'),
    key: z.string(),
    fencingToken: z.number().int(),
    reason: z.enum(['lost', 'released']),
  }),
]);

const mailBase = {
  ...base('mail'),
  messageId: z.string(),
  mail: z.string().optional(),
  recipients: z.array(z.string()),
  subject: z.string(),
  transport: z.string(),
  attempts: count,
  durationMs: ms,
};

const mailEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...mailBase,
    type: z.literal('sent'),
    providerMessageId: z.string().optional(),
  }),
  z.object({
    ...mailBase,
    type: z.literal('failed'),
    error: errorSchema,
    permanent: z.boolean(),
  }),
]);

const resilienceBase = {
  ...base('resilience'),
  policy: z.string(),
  /** What the policy guards, when it says (the event's own `source`). */
  origin: z.string().optional(),
};

const circuitState = z.enum(['closed', 'open', 'half-open']);

const resilienceEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...resilienceBase,
    type: z.literal('retry'),
    attempt: count,
    delayMs: ms,
    error: errorSchema,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('timeout'),
    timeoutMs: ms,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-open'),
    from: circuitState,
    to: z.literal('open'),
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-half-open'),
    from: circuitState,
    to: z.literal('half-open'),
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-closed'),
    from: circuitState,
    to: z.literal('closed'),
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('circuit-rejected'),
    retryAfterMs: ms,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('bulkhead-rejected'),
    reason: z.enum(['full', 'queue-timeout']),
    active: count,
    queued: count,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('rate-limited'),
    retryAfterMs: ms,
  }),
  z.object({
    ...resilienceBase,
    type: z.literal('fallback'),
    error: errorSchema,
  }),
]);

/**
 * The `data` of one message of the stream: the engine's event, tagged with
 * its `source`. Narrow by `source`, then by `type`.
 */
export const opsEventSchema = z.union([
  workflowEventSchema,
  webhooksEventSchema,
  outboxEventSchema,
  idempotencyEventSchema,
  locksEventSchema,
  mailEventSchema,
  resilienceEventSchema,
]);

export type OpsEvent = z.infer<typeof opsEventSchema>;
