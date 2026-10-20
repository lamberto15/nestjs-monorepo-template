import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { type Queue, UnrecoverableError } from 'bullmq';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { CoreEnv } from '../../core/config/core.env.js';
import type { Transaction } from '../../core/database/drizzle.js';
import {
  database,
  type DrizzleTransactions,
  inTransaction,
} from '../../core/database/transactions.js';
import { REDIS } from '../../core/redis/redis.js';
import type { TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  assertRequestPrincipal,
  type Principal,
  principalKey,
  type RequestPrincipal,
  type UserPrincipal,
} from '../../iam/auth/principal.js';
import {
  PersonalDataRegistry,
  type PersonalDataSource,
} from '../account/personal-data.registry.js';
import { ANONYMIZED_UPLOADER } from '../attachments/attachments.service.js';
import type { PlatformEnv } from '../platform.env.js';
import { Realtime } from '../realtime/realtime.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AI_ENABLED } from './ai-settings.js';
import {
  AiProvider,
  AiProviderRejected,
  AiProviderUnavailable,
} from './ai-provider.js';
import { AiRegistry } from './ai.registry.js';
import type { AiRequest, AiRunView } from './ai.schemas.js';
import { type AiRunRow, type AiRunStatus, aiRuns } from './ai.tables.js';
import { AI_TASKS, type AiTask } from './ai-tasks.js';

/** The queue of AI runs. */
export const AI = 'ai';

/** What a queued run carries: the run, who asked (checked again), and the tenant. */
export interface AiJob extends TenantEnvelope {
  readonly tenantId: string;
  id: string;
  principal: RequestPrincipal;
}

/** Why a run failed, as people read it (never provider or internal error text). */
export const AI_ERRORS = {
  principalGone: 'The account that asked is no longer active.',
  recordGone: 'The record no longer exists, or you may no longer read it.',
  invalid: 'The model did not answer in the expected shape; ask again later.',
  rejected: 'The AI provider refused this request.',
  unavailable:
    'The AI provider failed or did not answer in time; ask again later.',
  quota: "The tenant's daily AI quota is used up.",
} as const;

/** How long a finished run's output stays in the queue's result, in seconds. */
export const OUTPUT_KEPT_SECONDS = 3600;

const OPEN: AiRunStatus[] = ['queued', 'running'];

/** A run that cannot succeed, for a reason people can act on: not retried. */
class AiFailure extends UnrecoverableError {}

/**
 * The AI helper: a feature's AiSource gives a record's fields as the
 * requester may read them, a queue worker asks the provider for a structured
 * answer (a tool call validated with Zod), and the requester follows the run
 * at GET /v1/ai/runs/{id} and hears `ai.ready` over realtime. The row is the
 * usage record (model id, prompt version, tokens): it keeps no prompt and no
 * output, which are the record's personal data. The output lives in the
 * job's result for an hour, readable by the requester only.
 */
@Injectable()
export class AiService implements PersonalDataSource {
  readonly name = 'ai';
  private readonly logger = new Logger('Ai');

  /** The current transaction, or the database outside one (core/database/transactions.ts). */
  private get db() {
    return database(this.txHost);
  }

  constructor(
    @InjectQueue(AI) private readonly queue: Queue<AiJob>,
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly registry: AiRegistry,
    private readonly provider: AiProvider,
    private readonly audit: AuditService,
    private readonly realtime: Realtime,
    private readonly settings: SettingsService,
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    @Inject(REDIS) private readonly redis: Redis,
    personalData: PersonalDataRegistry,
  ) {
    personalData.register(this);
  }

  /**
   * Asks for a run: checked now (the helper on, the tenant opted in, the
   * source's `canUse`, the daily quota), done by a worker. 503
   * `ai_unavailable` without a key; 403 `ai_disabled` until the tenant opts
   * in; 429 `ai_quota_exceeded`; 409 `ai_pending` while the same requester's
   * run of the record and task is open.
   */
  async request(principal: RequestPrincipal, request: AiRequest, ip?: string) {
    if (!this.provider.enabled) {
      throw new ServiceUnavailableException({
        code: 'ai_unavailable',
        message: 'The AI helper is not set up on this server.',
      });
    }
    if (!(await this.settings.get(AI_ENABLED, principal))) {
      throw new ForbiddenException({
        code: 'ai_disabled',
        message: 'The AI helper is off for this tenant (setting ai.enabled).',
      });
    }
    const source = this.registry.get(request.source);
    if (!source) {
      throw new NotFoundException(`No AI source named "${request.source}".`);
    }
    if (!(await source.canUse(principal, request.recordId))) {
      throw new ForbiddenException(
        `You may not use the AI helper on ${source.subject} ${request.recordId}.`,
      );
    }
    assertRequestPrincipal(principal, 'A queued AI run');
    const tenantId = requireTenantId('An AI run');
    if (principal.tenantId !== tenantId) {
      throw new Error("An AI run is done in its requester's tenant only.");
    }
    const task = AI_TASKS[request.task];
    await this.assertQuota();
    const pending = {
      source: source.name,
      recordId: request.recordId,
      task: task.name,
      requestedBy: principalKey(principal),
    };
    const row = await inTransaction(this.txHost, async (tx) => {
      const [row] = await tx
        .insert(aiRuns)
        .values({
          ...pending,
          subject: source.subject,
          promptVersion: task.version,
          status: 'queued',
        })
        .returning();
      await this.audit.record(
        principal,
        {
          action: 'ai.requested',
          targetType: 'ai_run',
          targetId: row!.id,
          details: {
            source: source.name,
            subject: source.subject,
            recordId: request.recordId,
            task: task.name,
            promptVersion: task.version,
          },
          ip,
        },
        tx,
      );
      return row!;
    }).catch(async (error: unknown) => {
      const code =
        (error as { code?: string })?.code ??
        (error as { cause?: { code?: string } })?.cause?.code;
      if (code !== '23505') throw error;
      const [open] = await this.db
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.source, pending.source),
            eq(aiRuns.recordId, pending.recordId),
            eq(aiRuns.task, pending.task),
            eq(aiRuns.requestedBy, pending.requestedBy),
            inArray(aiRuns.status, OPEN),
          ),
        );
      throw new ConflictException({
        code: 'ai_pending',
        message: 'This is already being done for you: wait for it.',
        id: open?.id,
      });
    });
    try {
      await this.queue.add(
        task.name,
        { id: row.id, principal, tenantId },
        {
          // The run's id: a job is queued once per run.
          jobId: row.id,
          attempts: this.config.get('AI_ATTEMPTS', { infer: true }),
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: OUTPUT_KEPT_SECONDS },
          removeOnFail: { age: OUTPUT_KEPT_SECONDS },
        },
      );
    } catch (error) {
      await this.fail(
        { id: row.id, principal, tenantId },
        AI_ERRORS.unavailable,
      );
      throw error;
    }
    return { id: row.id, status: 'queued' as const };
  }

  /** 429 once the tenant's tokens today reach AI_TENANT_DAILY_TOKENS (0: no cap). */
  private async assertQuota() {
    const cap = this.config.get('AI_TENANT_DAILY_TOKENS', { infer: true });
    if (cap === 0) return;
    const [{ used } = { used: 0 }] = await this.db
      .select({
        used: sql<number>`coalesce(sum(${aiRuns.inputTokens} + ${aiRuns.outputTokens}), 0)::int`,
      })
      .from(aiRuns)
      .where(gte(aiRuns.createdAt, startOfUtcDay()));
    if (used >= cap) {
      throw new HttpException(
        {
          code: 'ai_quota_exceeded',
          message: `The tenant's daily AI quota of ${cap} tokens is used up; it starts again at midnight UTC.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** A run the principal asked for, with its output while it is kept; else a 404. */
  async status(principal: Principal, id: string): Promise<AiRunView> {
    const [row] = await this.db.select().from(aiRuns).where(eq(aiRuns.id, id));
    // The output is the requester's: what they could read of the record.
    if (!row || row.requestedBy !== principalKey(principal)) {
      throw new NotFoundException(`AI run ${id} not found.`);
    }
    let output: Record<string, unknown> | null = null;
    if (row.status === 'completed') {
      const job = await this.queue.getJob(id);
      // The row commits before BullMQ stores the job's result: until the job
      // has finished, the run is still running for its reader.
      if (job && !job.finishedOn)
        return view({ ...row, status: 'running' }, null);
      const kept: unknown = job?.returnvalue;
      output =
        kept && typeof kept === 'object'
          ? (kept as Record<string, unknown>)
          : null;
    }
    return view(row, output);
  }

  /** On the worker: asks the provider (or the cache) and completes the run. */
  async run(
    job: AiJob,
    principal: RequestPrincipal | null,
  ): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .update(aiRuns)
      .set({ status: 'running' })
      .where(and(eq(aiRuns.id, job.id), inArray(aiRuns.status, OPEN)))
      .returning();
    if (!row) {
      throw new UnrecoverableError(`AI run ${job.id} is not open: not run.`);
    }
    if (!principal) throw new AiFailure(AI_ERRORS.principalGone);
    const source = this.registry.get(row.source);
    if (!source) {
      throw new UnrecoverableError(`No AI source "${row.source}".`);
    }
    const task = AI_TASKS[row.task as keyof typeof AI_TASKS] as
      AiTask | undefined;
    if (!task) throw new UnrecoverableError(`No AI task "${row.task}".`);
    let content;
    try {
      content = await source.content(principal, row.recordId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new AiFailure(AI_ERRORS.recordGone);
      }
      throw error;
    }
    const model = this.config.get(
      task.tier === 'cheap' ? 'AI_MODEL_CHEAP' : 'AI_MODEL',
      { infer: true },
    );
    const prompt = framePrompt(task, content);
    // The key names tenant, model and prompt version, plus the exact prompt
    // (so field-level differences between callers never share an answer).
    const cacheKey = `tenant:${row.tenantId}:ai:cache:${createHash('sha256')
      .update(JSON.stringify([task.name, task.version, model, prompt]))
      .digest('hex')}`;
    const ttl = this.config.get('AI_CACHE_TTL_SECONDS', { infer: true });
    let output: Record<string, unknown> | undefined;
    let cached = false;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let answeredBy = model;
    if (ttl > 0) {
      const hit = await this.redis.get(cacheKey).catch(() => null);
      if (hit) {
        output = JSON.parse(hit) as Record<string, unknown>;
        cached = true;
      }
    }
    if (!output) {
      let completion;
      try {
        completion = await this.provider.complete({
          model,
          system: task.system,
          prompt,
          tool: {
            name: 'answer',
            description: task.description,
            schema: z.toJSONSchema(task.schema) as Record<string, unknown>,
          },
          maxTokens: this.config.get('AI_MAX_OUTPUT_TOKENS', { infer: true }),
          timeoutMs: this.config.get('AI_TIMEOUT_MS', { infer: true }),
        });
      } catch (error) {
        if (error instanceof AiProviderRejected) {
          throw new AiFailure(AI_ERRORS.rejected);
        }
        throw error; // unavailable: retried
      }
      const parsed = task.schema.safeParse(completion.output);
      if (!parsed.success) {
        // Spent, but unusable: never retried (it would be paid twice).
        await this.complete(row, principal, {
          status: 'failed',
          usage: completion.usage,
          model: completion.model,
          error: AI_ERRORS.invalid,
        });
        throw new AiFailure(AI_ERRORS.invalid);
      }
      output = parsed.data as Record<string, unknown>;
      usage = completion.usage;
      answeredBy = completion.model;
      if (ttl > 0) {
        await this.redis
          .set(cacheKey, JSON.stringify(output), 'EX', ttl)
          .catch(() => undefined);
      }
    }
    await this.complete(row, principal, {
      status: 'completed',
      usage,
      model: answeredBy,
      cached,
    });
    // After the commit: a client never hears of a run that rolled back.
    this.realtime.toPrincipal(principal, 'ai.ready', {
      id: row.id,
      subject: row.subject,
      recordId: row.recordId,
      task: row.task,
    });
    this.logger.log('AI run completed', {
      id: row.id,
      task: row.task,
      model: answeredBy,
      cached,
      ...usage,
    });
    return output;
  }

  /** The run's outcome and its audit entry, in one transaction (only while open). */
  private async complete(
    row: AiRunRow,
    principal: RequestPrincipal,
    outcome: {
      status: 'completed' | 'failed';
      usage: { inputTokens: number; outputTokens: number };
      model: string;
      cached?: boolean;
      error?: string;
    },
  ) {
    await inTransaction(this.txHost, async (tx) => {
      const [done] = await tx
        .update(aiRuns)
        .set({
          status: outcome.status,
          model: outcome.model,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          cached: outcome.cached ?? false,
          error: outcome.error ?? null,
        })
        .where(and(eq(aiRuns.id, row.id), inArray(aiRuns.status, OPEN)))
        .returning();
      if (!done) return;
      await this.audit.record(
        principal,
        {
          action: outcome.status === 'completed' ? 'ai.completed' : 'ai.failed',
          targetType: 'ai_run',
          targetId: row.id,
          details: {
            source: row.source,
            recordId: row.recordId,
            task: row.task,
            promptVersion: row.promptVersion,
            model: outcome.model,
            cached: outcome.cached ?? false,
            ...outcome.usage,
            ...(outcome.error ? { error: outcome.error } : {}),
          },
        },
        tx,
      );
    });
  }

  /**
   * A run that failed for good: state and audit in one transaction, then the
   * requester told. Idempotent (only an open run fails).
   */
  async fail(
    job: AiJob,
    reason: string,
    principal: Pick<Principal, 'kind' | 'id'> = job.principal,
  ) {
    const failed = await inTransaction(this.txHost, async (tx) => {
      const [failed] = await tx
        .update(aiRuns)
        .set({ status: 'failed', error: reason })
        .where(and(eq(aiRuns.id, job.id), inArray(aiRuns.status, OPEN)))
        .returning();
      if (failed) {
        await this.audit.record(
          principal as Principal,
          {
            action: 'ai.failed',
            targetType: 'ai_run',
            targetId: failed.id,
            details: {
              source: failed.source,
              recordId: failed.recordId,
              task: failed.task,
              error: reason,
            },
          },
          tx,
        );
      }
      return failed;
    });
    if (!failed) return;
    this.realtime.toPrincipal(principal, 'ai.failed', {
      id: failed.id,
      subject: failed.subject,
      recordId: failed.recordId,
      error: reason,
    });
  }

  /** The user's runs (no prompts, no outputs), for their data export. */
  async *rows(user: UserPrincipal) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.requestedBy, principalKey(user)),
            cursor ? lt(aiRuns.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(aiRuns.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  /** Their account is deleted: the usage stays (it counts toward the quota), asked for by nobody. */
  async erase(tx: Transaction, user: UserPrincipal) {
    await tx
      .update(aiRuns)
      .set({ requestedBy: ANONYMIZED_UPLOADER })
      .where(eq(aiRuns.requestedBy, principalKey(user)));
  }

  /** Whether a failure is final for the processor: a transient provider error is retried. */
  static transient(error: unknown) {
    return error instanceof AiProviderUnavailable;
  }
}

const startOfUtcDay = () => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
};

/**
 * The user message: the record as data between tags. JSON escapes quotes and
 * the angle brackets are escaped too, so the content cannot close the tag
 * and pass for instructions; the system prompt says what it is.
 */
const framePrompt = (
  task: AiTask,
  content: { title: string; fields: Record<string, unknown> },
) =>
  `Task: ${task.description}\n<record>\n${JSON.stringify({
    title: content.title,
    fields: content.fields,
  }).replaceAll('<', '\\u003c')}\n</record>`;

const view = (
  row: AiRunRow,
  output: Record<string, unknown> | null,
): AiRunView => ({
  id: row.id,
  source: row.source,
  subject: row.subject,
  recordId: row.recordId,
  task: row.task,
  promptVersion: row.promptVersion,
  model: row.model,
  status: row.status,
  output,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cached: row.cached,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
