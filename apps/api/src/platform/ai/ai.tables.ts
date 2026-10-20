import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantColumn, tenantTable } from '../../core/tenancy/tenant-scope.js';

export const AI_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

/**
 * What the AI helper was asked, and what it cost: one row per request, kept
 * as the usage record behind the tenant's daily quota. It holds no prompt and
 * no output (they carry the record's personal data): the output lives in the
 * queue's result for an hour, and the prompt is built again from the record
 * on the worker. The model id and the prompt-template version are stored so
 * a change of either can be traced to the runs it affects.
 */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    /** The AiSource that gives the record's fields: `note`. */
    source: text('source').notNull(),
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The task (`summarize`) and the version of its prompt template. */
    task: text('task').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** The exact model id the provider answered with (null until it did). */
    model: text('model'),
    status: text('status').$type<AiRunStatus>().notNull(),
    /** `user:<id>` or `client:<id>`; `anonymized` after their account was deleted. */
    requestedBy: text('requested_by').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Answered from the cache: no tokens were spent. */
    cached: boolean('cached').notNull().default(false),
    /** Why it failed, written for people. */
    error: text('error'),
    ...timestamps(),
  },
  (table) => [
    index('ai_runs_tenant_day_idx').on(table.tenantId, table.createdAt),
    index('ai_runs_requested_by_idx').on(table.requestedBy),
    // One run at a time per record, task and requester.
    uniqueIndex('ai_runs_pending_idx')
      .on(
        table.tenantId,
        table.source,
        table.recordId,
        table.task,
        table.requestedBy,
      )
      .where(sql`${table.status} in ('queued', 'running')`),
    ...tenantTable('ai_runs', table),
  ],
).enableRLS();

export type AiRunRow = typeof aiRuns.$inferSelect;
