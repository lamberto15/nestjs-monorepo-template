import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { z } from 'zod';
import type { ListQuery } from '../../core/http/list-query.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  assertRequestPrincipal,
  principalKey,
  type Principal,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import type { PlatformEnv } from '../platform.env.js';
import { JobIndex, type JobPage } from '../queues/job-index.js';
import { BulkRegistry } from './bulk.registry.js';
import { BulkTally, itemError, skipped } from './bulk.results.js';
import {
  type BulkJob,
  type BulkOperation,
  type BulkResult,
  type BulkSelection,
  MAX_BULK_IDS,
} from './bulk.types.js';

/** The queue of bulk runs too large for a request. */
export const BULK = 'bulk';

/** A queued job reports its progress every this many items. */
export const BULK_PROGRESS_EVERY = 100;

/** A request to act on many records of a feature at once. */
export interface BulkRequest {
  /** The operation a feature registered (`notes`). */
  name: string;
  action: string;
  ids?: string[];
  filter?: Record<string, unknown>;
  input?: unknown;
  ip?: string;
}

/** A 400 validation_failed naming where the request is wrong. */
const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** `schema.parse(value)`, its issues as a validation_failed under `path`. */
function parseAt<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues.map((issue) => ({
        path: [path, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

const idsSchema = z.array(z.uuid()).min(1);
/** Keys of a list query that are not filters. */
const NOT_FILTERS = new Set([
  'limit',
  'page',
  'cursor',
  'count',
  'sort',
  'fields',
  'deleted',
  'lang',
]);

/**
 * Acts on many records of a feature at once, each item as the feature's
 * own route would (its BulkOperation). Small runs (BULK_SYNC_LIMIT ids)
 * answer in the request; larger ones, and every `filter` selection, go to
 * the `bulk` queue and are reported to the principal who started them, and
 * to nobody else.
 */
@Injectable()
export class BulkService {
  constructor(
    @InjectQueue(BULK) private readonly queue: Queue<BulkJob, BulkResult>,
    private readonly registry: BulkRegistry,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly jobs: JobIndex,
  ) {}

  /** Runs it now (the result), or queues it (`{ id, status: 'queued' }`). */
  async run(
    principal: RequestPrincipal,
    request: BulkRequest,
  ): Promise<BulkResult | { id: string; status: 'queued' }> {
    const operation = this.registry.get(request.name);
    if (!operation) {
      throw new NotFoundException(
        `Nothing to do in bulk named "${request.name}".`,
      );
    }
    const action = operation.actions[request.action];
    if (!action) {
      throw invalid([
        {
          path: 'action',
          message: `Not an action of ${operation.name}: send one of ${Object.keys(operation.actions).join(', ')}.`,
        },
      ]);
    }
    if (
      !(await this.access.can(principal, action.permission, operation.subject))
    ) {
      throw new ForbiddenException();
    }
    if ((request.ids === undefined) === (request.filter === undefined)) {
      throw invalid([
        { path: 'ids', message: 'Send ids or filter: one of them.' },
      ]);
    }
    let ids: string[] | undefined;
    if (request.ids !== undefined) {
      ids = [...new Set(parseAt(idsSchema, request.ids, 'ids'))];
      if (ids.length > MAX_BULK_IDS) {
        throw new BadRequestException({
          code: 'bulk_too_many',
          message: `At most ${MAX_BULK_IDS} ids at once: select more with a filter.`,
          limit: MAX_BULK_IDS,
        });
      }
    }
    // Checked now, so a typo is a 400, not a failed job. The job keeps them
    // raw (it travels as JSON: parsed dates would arrive as strings).
    const parsed = await this.parse(principal, operation, {
      ...request,
      ids,
    });
    assertRequestPrincipal(principal, 'A queued bulk operation');
    const tenantId = requireTenantId('A bulk operation');
    if (principal.tenantId !== tenantId) {
      // A bug, never a caller's choice: the run would act in another tenant.
      throw new Error("A bulk run acts in its principal's tenant only.");
    }
    const job: BulkJob = {
      tenantId,
      principal,
      name: operation.name,
      action: request.action,
      ...(ids ? { ids } : { filter: request.filter }),
      input: request.input,
      ip: request.ip,
    };
    // A filter's size is unknown until it runs: always a job.
    const syncLimit = this.config.get('BULK_SYNC_LIMIT', { infer: true });
    if (!ids || ids.length > syncLimit) {
      return this.enqueue(job);
    }
    const id = randomUUID();
    await this.started(job, id);
    const result = await this.execute(
      principal,
      operation,
      request.action,
      parsed.selection,
      parsed.input,
      request.ip,
    );
    await this.finished(principal, job, id, result);
    return result;
  }

  /**
   * The selection and input as the operation takes them, parsed (the
   * request's, or a job's again: the principal's permissions may have
   * changed since).
   */
  async parse(
    principal: Principal,
    operation: BulkOperation,
    request: Omit<BulkRequest, 'name'>,
  ) {
    const action = operation.actions[request.action]!;
    let selection: BulkSelection = { ids: request.ids };
    if (request.filter !== undefined) {
      if (!operation.filters) {
        throw invalid([
          {
            path: 'filter',
            message: `${operation.name} are selected by ids only.`,
          },
        ]);
      }
      // The list's query schema also takes paging, sort and the recycle bin:
      // meaningless for a run that acts on every match, so refused rather
      // than ignored (a `limit` would not limit). An empty filter would act
      // on every record the caller may: ask for at least one condition.
      const keys = Object.keys(request.filter);
      const stray = keys.filter((key) => NOT_FILTERS.has(key));
      if (stray.length) {
        throw invalid(
          stray.map((key) => ({
            path: `filter.${key}`,
            message: 'Not a filter: a bulk run acts on every match.',
          })),
        );
      }
      if (keys.length === 0) {
        throw invalid([
          {
            path: 'filter',
            message: 'At least one condition: a bulk run acts on every match.',
          },
        ]);
      }
      selection = {
        filter: parseAt(operation.filters, request.filter, 'filter'),
      };
      // Field-level: which records a run acts on would tell a hidden field's values.
      // Among the rows the run's action reaches (the source's select()).
      await this.access.assertQueryFields(
        principal,
        operation.subject,
        selection.filter as ListQuery,
        { reach: request.action },
      );
    }
    if (!action.input && request.input !== undefined) {
      throw invalid([
        { path: 'input', message: `${request.action} takes no input.` },
      ]);
    }
    const input = action.input
      ? parseAt(action.input, request.input ?? {}, 'input')
      : undefined;
    return { selection, input };
  }

  /**
   * Performs the action on every selected record, one at a time, each in
   * the feature's own transaction: a 4xx fails that item alone; ids the
   * selection did not yield are skipped.
   */
  async execute(
    principal: Principal,
    operation: BulkOperation,
    action: string,
    selection: BulkSelection,
    input: unknown,
    ip?: string,
    {
      cap,
      progress,
    }: {
      cap?: number;
      progress?: (tally: BulkTally) => Promise<void>;
    } = {},
  ): Promise<BulkResult> {
    const tally = new BulkTally(cap);
    // Which ids were found: only for an ids selection (a filter's matches are unbounded).
    const seen = selection.ids ? new Set<string>() : undefined;
    for await (const batch of operation.select(principal, action, selection)) {
      for (const record of batch) {
        seen?.add(record.id);
        try {
          await operation.perform(principal, action, record, input, ip);
          tally.add({ id: record.id, status: 'done' });
        } catch (error) {
          const failure = itemError(error);
          if (!failure) {
            throw error;
          }
          tally.add({ id: record.id, status: 'failed', error: failure });
        }
        if (progress && tally.processed % BULK_PROGRESS_EVERY === 0) {
          await progress(tally);
        }
      }
    }
    for (const id of selection.ids ?? []) {
      if (!seen!.has(id)) {
        tally.add(skipped(id, action));
      }
    }
    return tally.result(selection.ids);
  }

  /**
   * A run of this principal in this tenant: its state, progress and result.
   * Another tenant's run is a 404, even the same person's.
   */
  async status(principal: Principal, id: string) {
    const job = await this.queue.getJob(id);
    if (!job || !isOwn(principal, job)) {
      throw new NotFoundException(`Bulk run ${id} not found.`);
    }
    return this.view(job);
  }

  /**
   * The runs this principal handed to the workers in this tenant, newest
   * first, by cursor (the last id of the previous page), each as
   * `status()` tells it without the result per item (its counts stay):
   * GET /v1/bulk/{id} has them. Those BullMQ still keeps (7 days after
   * they end); runs answered in the request were never jobs.
   */
  async list(
    principal: RequestPrincipal,
    query: { limit: number; cursor?: string },
  ): Promise<JobPage<BulkRunView>> {
    return this.jobs.page(
      BULK,
      requireTenantId('A bulk run'),
      principal,
      query,
      async (id) => {
        const job = await this.queue.getJob(id);
        if (!job || !isOwn(principal, job)) {
          return null;
        }
        const run = await this.view(job);
        if (!run.result) {
          return run;
        }
        const { results: _results, ...counts } = run.result;
        return { ...run, result: counts };
      },
    );
  }

  /** A run's state, progress and result. */
  private async view(
    read: Job<BulkJob, BulkResult>,
  ): Promise<Omit<BulkRunView, 'result'> & { result?: BulkResult }> {
    const id = read.id!;
    let job = read;
    const state = await job.getState();
    if (
      (state === 'completed' && job.returnvalue == null) ||
      (state === 'failed' && job.failedReason == null)
    ) {
      // It ended between the two reads (the job was read while it ran): read
      // it again, with its result or its reason. Without this a failure read
      // that way had no reason, and answered the generic message.
      job = (await this.queue.getJob(id)) ?? job;
    }
    const base = {
      id,
      name: job.data.name,
      action: job.data.action,
      status:
        state === 'completed'
          ? ('completed' as const)
          : state === 'failed'
            ? ('failed' as const)
            : state === 'active'
              ? ('running' as const)
              : ('queued' as const),
      progress:
        typeof job.progress === 'object'
          ? (job.progress as Record<string, number>)
          : { processed: 0 },
    };
    if (state === 'failed') {
      // Only a message written for people; never internal error text.
      return { ...base, error: publicReason(job.failedReason) };
    }
    return state === 'completed' ? { ...base, result: job.returnvalue } : base;
  }

  /** Audits the start of a run: what it acts on, by how many ids or by a filter. */
  started(job: BulkJob, id: string) {
    return this.audit.record(job.principal, {
      action: 'bulk.started',
      targetType: 'bulk',
      targetId: id,
      details: {
        name: job.name,
        action: job.action,
        ...(job.ids ? { ids: job.ids.length } : { filter: job.filter }),
      },
      ip: job.ip,
    });
  }

  /** Audits its end with its counts; each item has the feature's own entry. */
  finished(
    principal: Principal,
    job: BulkJob,
    id: string,
    { done, failed, skipped: notFound }: BulkResult,
  ) {
    return this.audit.record(principal, {
      action: 'bulk.finished',
      targetType: 'bulk',
      targetId: id,
      details: {
        name: job.name,
        action: job.action,
        done,
        failed,
        skipped: notFound,
      },
      ip: job.ip,
    });
  }

  private async enqueue(job: BulkJob) {
    const jobId = randomUUID();
    // Listed for its principal (GET /bulk) before it is queued.
    await this.jobs.add([BULK], job.tenantId, job.principal, jobId);
    const added = await this.queue.add(job.name, job, {
      jobId,
      // Never retried blindly: the items done would be done twice.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
    });
    await this.started(job, added.id!);
    return { id: added.id!, status: 'queued' as const };
  }
}

/**
 * Whether the principal may see this run: theirs, started in this tenant.
 * Another tenant's run is unseen, even the same person's.
 */
const isOwn = (principal: Principal, job: Job<BulkJob, BulkResult>) =>
  job.data.tenantId === requireTenantId('A bulk run') &&
  principalKey(job.data.principal) === principalKey(principal);

/** A run as an item of GET /v1/bulk: its result's counts, not each item's. */
export interface BulkRunView {
  id: string;
  name: string;
  action: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: Record<string, number>;
  result?: Omit<BulkResult, 'results'>;
  error?: string;
}

/** The one reason a person can act on; anything else (a database error) stays in the logs. */
export const PRINCIPAL_GONE =
  'The account that started this bulk run is no longer active.';
const publicReason = (reason: string | undefined) =>
  reason === PRINCIPAL_GONE
    ? reason
    : 'The bulk run stopped. Items done stay done; ask an administrator (the run id is in the logs).';
