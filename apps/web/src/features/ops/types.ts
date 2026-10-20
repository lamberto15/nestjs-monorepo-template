/**
 * The operations API's answers. Its OpenAPI document leaves these bodies
 * untyped (issue #270 asks for schemas), so they are declared here, from
 * `platform/ops/ops.controller.ts`, `ops-queues.service.ts` and
 * `@nestjs/outbox`'s interfaces.
 */

export type OutboxStats = {
  pending: number;
  ready: number;
  leased: number;
  deadLetters: number;
  /** Epoch ms since which the longest-waiting message has waited, or null. */
  oldestDueAt: number | null;
  /** How long it has waited, in ms: the number to alert on. */
  lagMs: number;
  inFlight: number;
};

export type DeadLetter = {
  id: string;
  topic: string;
  key: string | null;
  attempts: number;
  lastError: string | null;
  reason: 'exhausted' | 'rejected';
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  failedAt: number;
};

export type OpsOutbox = {
  stats: OutboxStats;
  /** The latest 50. */
  deadLetters: DeadLetter[];
  notifications: { undelivered: number };
  canManage: boolean;
};

export type QueueCounts = {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
};

export type QueueFailure = {
  id: string | number | null;
  name: string;
  attempts: number;
  reason: string | null;
  failedAt: string | null;
};

export type QueueOverview = {
  name: string;
  paused: boolean;
  counts: QueueCounts;
  recentFailures: QueueFailure[];
};

/** One message of the live log (`data: {source, at, …}`). */
export type OpsEventData = {
  source: string;
  /** Epoch ms. */
  at: number;
} & Record<string, unknown>;
