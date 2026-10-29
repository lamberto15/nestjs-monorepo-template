import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  type MessageEvent,
  Post,
  SerializeOptions,
  Sse,
  StandardSchemaSerializerInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { IdempotencyEvents } from '@nestjs/idempotency';
import { LocksEvents } from '@nestjs/locks';
import { MailEvents } from '@nestjs/mail';
import { ResilienceEvents } from '@nestjs/resilience';
import { OutboxDeadLetters, OutboxEvents, OutboxRelay } from '@nestjs/outbox';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { WebhooksEvents } from '@nestjs/webhooks';
import { WorkflowEvents } from '@nestjs/workflows';
import { filter, map, merge, type Observable } from 'rxjs';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { redactValue } from '../../core/logging/redaction.js';
import { opsEvent } from './ops-events.js';
import {
  backlogActionSchema,
  backlogPreviewSchema,
  backlogResultSchema,
  backlogScopeSchema,
  diagnosticTestSchema,
  diagnosticsSchema,
  opsEventSchema,
  outboxStateSchema,
  purgedSchema,
  queueOverviewSchema,
  queuePausedSchema,
  requeuedSchema,
  retriedSchema,
  type OpsEvent,
} from './ops.schemas.js';
import { OpsPolicy } from './ops.policy.js';
import { OpsQueues } from './ops-queues.service.js';
import { OpsBacklog, type BacklogScope } from './ops-backlog.service.js';
import { OpsDiagnostics } from './ops-diagnostics.service.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import { minutes } from '@nestjs/throttler';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

const idsSchema = z.object({ ids: z.array(z.string()).max(1000).optional() });

/** The scope as the service takes it: `before` as a Date. */
const scopeOf = ({
  before,
  ...scope
}: z.infer<typeof backlogScopeSchema>): BacklogScope => ({
  ...scope,
  before: before ? new Date(before) : undefined,
});

/**
 * Operations: what runs in the background. Outbox stats, dead letters (requeue,
 * purge), and every engine's events as a live stream. User sessions only.
 * Every answer goes through its schema (ops.schemas.ts: the OpenAPI document
 * and the response are the same declaration), and what an engine holds (error
 * messages, payloads) is masked by the log-redaction registry and cut before
 * it reaches a browser; a stack trace never does.
 * The queues, the outbox and the engines are the deployment's, every
 * tenant's work together: only the operators may see them (the operator
 * tenant, `@OperatorOnly()`, docs/tenancy.md), on top of `Ops.*`.
 */
@ApiTags('ops')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@UserOnly()
@OperatorOnly()
@AllowInMaintenance()
@UseInterceptors(StandardSchemaSerializerInterceptor)
@Controller('ops')
export class OpsController {
  constructor(
    private readonly outboxRelay: OutboxRelay,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly outboxEvents: OutboxEvents,
    private readonly workflowEvents: WorkflowEvents,
    private readonly webhooksEvents: WebhooksEvents,
    private readonly idempotencyEvents: IdempotencyEvents,
    private readonly locksEvents: LocksEvents,
    private readonly mailEvents: MailEvents,
    private readonly resilienceEvents: ResilienceEvents,
    private readonly queues: OpsQueues,
    private readonly opsPolicy: OpsPolicy,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly diagnostics: OpsDiagnostics,
    private readonly backlog: OpsBacklog,
  ) {}

  @Get('outbox')
  @Can(OpsPolicy, 'view')
  @SerializeOptions({ schema: outboxStateSchema })
  @ApiOperation({
    summary: 'Outbox stats and the latest 50 dead letters',
    description:
      'lagMs is the number to alert on: how long the oldest due message has waited. notifications.undelivered: stored notifications the worker has not delivered, though older than ten minutes; it stops at 10,000 and undeliveredCapped is then true. Errors, payloads and headers are masked as in the logs and cut; no stack traces.',
  })
  @ApiOkResponse({ standardSchema: outboxStateSchema })
  async state(@CurrentUser() user: UserPrincipal) {
    return {
      stats: await this.outboxRelay.stats(),
      deadLetters: (await this.deadLetters.list({ limit: 50 })).map((letter) =>
        redactValue(letter),
      ),
      notifications: await this.notifications.undelivered(),
      canManage: await this.opsPolicy.manage(user),
    };
  }

  /** Every engine's events as they happen: a live log for a dashboard. */
  @Sse('events')
  @Can(OpsPolicy, 'view')
  @ApiOperation({
    summary:
      'Live events of workflows, webhooks, the outbox, idempotency, locks, mail and resilience (Server-Sent Events)',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description:
      'A stream of `data: {source, at, type, …}` messages, each one JSON: the schema describes that `data`. Errors, payloads and headers are masked as in the logs and cut; no stack traces.',
    // The schema of one message's `data` (OpenAPI 3.1 reads a stream's item
    // schema from `itemSchema`; here it is the media type's schema).
    standardSchema: opsEventSchema,
    content: undefined,
  })
  events(): Observable<MessageEvent> {
    const tagged = (source: OpsEvent['source']) =>
      map((event: object) => opsEvent(source, event));
    return merge(
      this.workflowEvents.events$.pipe(tagged('workflow')),
      this.webhooksEvents.events$.pipe(tagged('webhooks')),
      this.outboxEvents.events$.pipe(tagged('outbox')),
      this.idempotencyEvents.events$.pipe(tagged('idempotency')),
      this.locksEvents.events$.pipe(tagged('locks')),
      this.mailEvents.events$.pipe(tagged('mail')),
      this.resilienceEvents.events$.pipe(tagged('resilience')),
    ).pipe(
      filter((data): data is OpsEvent => data !== undefined),
      map((data) => ({ data })),
    );
  }

  @Get('queues')
  @Can(OpsPolicy, 'view')
  @SerializeOptions({ schema: queueOverviewSchema })
  @ApiOperation({
    summary: 'Background job queues: counts by state and the latest failures',
    description:
      'Failure reasons are masked as in the logs and cut; no stack traces.',
  })
  @ApiOkResponse({ standardSchema: queueOverviewSchema })
  async queueOverview() {
    return { items: await this.queues.overview() };
  }

  @Get('diagnostics')
  @Can(OpsPolicy, 'view')
  @SerializeOptions({ schema: diagnosticsSchema })
  @ApiOperation({
    summary:
      'Integration diagnostics: database, Redis, workers, mail, storage, realtime',
    description:
      'Each one ok, configured (set up, not probed: run its test), disabled, unconfigured or unavailable, with a hint. Built from switches and driver names: no URL, host credential or key is ever in it; errors are masked as in the logs and cut.',
  })
  @ApiOkResponse({ standardSchema: diagnosticsSchema })
  async diagnosticsOverview(@CurrentUser() user: UserPrincipal) {
    return {
      items: await this.diagnostics.overview(),
      canTest: await this.opsPolicy.manage(user),
    };
  }

  /** A safe connection test: nothing a user sees (no mail sent, a probe file deleted at once). */
  @Post('diagnostics/:check/test')
  @Can(OpsPolicy, 'manage')
  @UserThrottle({ limit: 10, ttl: minutes(1) })
  @HttpCode(200)
  @SerializeOptions({ schema: diagnosticTestSchema })
  @ApiOperation({
    summary: 'Test one integration now (safe: sends nothing, keeps nothing)',
    description:
      'SMTP: connects, authenticates and says QUIT. Storage: writes, reads and deletes a probe file. Database, Redis, realtime: a ping; workers: at least one connected. A failure answers 200 with ok false and the masked reason. 400 not_testable when the configuration has nothing to probe. 10 per minute per user. Audited.',
  })
  @ApiOkResponse({ standardSchema: diagnosticTestSchema })
  async testDiagnostic(
    @CurrentUser() user: UserPrincipal,
    @Param('check') check: string,
    @Ip() ip: string,
  ) {
    const result = await this.diagnostics.test(check);
    await this.audit.record(user, {
      action: 'ops.diagnostic-tested',
      targetType: 'integration',
      targetId: check,
      details: { ok: result.ok, durationMs: result.durationMs },
      ip,
    });
    return result;
  }

  /** A queue's failed jobs, run again. */
  @Post('queues/:name/retry-failed')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @SerializeOptions({ schema: retriedSchema })
  @ApiOperation({ summary: "Retry a queue's failed jobs" })
  @ApiOkResponse({ standardSchema: retriedSchema })
  async retryFailed(
    @CurrentUser() user: UserPrincipal,
    @Param('name') name: string,
    @Ip() ip: string,
  ) {
    const retried = await this.queues.retryFailed(name);
    await this.audit.record(user, {
      action: 'queue.failed-retried',
      targetType: 'queue',
      targetId: name,
      details: { retried },
      ip,
    });
    return { retried };
  }

  /** A queue stopped for every process: its jobs wait in Redis, running ones finish. */
  @Post('queues/:name/pause')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @SerializeOptions({ schema: queuePausedSchema })
  @ApiOperation({
    summary: 'Pause a queue (every worker stops taking its jobs)',
    description:
      'BullMQ pause, kept in Redis: nothing is lost, and running jobs finish. Leaving maintenance mode resumes every queue. The outbox keeps queuing jobs into it: see /v1/ops/backlog. Audited.',
  })
  @ApiOkResponse({ standardSchema: queuePausedSchema })
  async pauseQueue(
    @CurrentUser() user: UserPrincipal,
    @Param('name') name: string,
    @Ip() ip: string,
  ) {
    await this.queues.pause(name);
    await this.audit.record(user, {
      action: 'queue.paused',
      targetType: 'queue',
      targetId: name,
      ip,
    });
    return { name, paused: true };
  }

  @Post('queues/:name/resume')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @SerializeOptions({ schema: queuePausedSchema })
  @ApiOperation({ summary: 'Resume a paused queue. Audited.' })
  @ApiOkResponse({ standardSchema: queuePausedSchema })
  async resumeQueue(
    @CurrentUser() user: UserPrincipal,
    @Param('name') name: string,
    @Ip() ip: string,
  ) {
    await this.queues.resume(name);
    await this.audit.record(user, {
      action: 'queue.resumed',
      targetType: 'queue',
      targetId: name,
      ip,
    });
    return { name, paused: false };
  }

  /** The dry run: what a discard or a retry with this scope would touch. */
  @Post('backlog/preview')
  @Can(OpsPolicy, 'view')
  @HttpCode(200)
  @SerializeOptions({ schema: backlogPreviewSchema })
  @ApiOperation({
    summary:
      'Count the outbox and mail backlog of one tenant (or, explicitly, every tenant)',
    description:
      'Changes nothing. The outbox (pending messages by topic and notification type, dead letters, those being delivered) and the mail queue (jobs by state and mail class). Exactly one of tenantId and global: true. topic and type narrow the outbox, template the mail queue, before (ISO 8601) keeps to older work. Mail queued before jobs named their tenant counts under global only.',
  })
  @ApiOkResponse({ standardSchema: backlogPreviewSchema })
  async previewBacklog(
    @Body({ schema: backlogScopeSchema })
    body: z.infer<typeof backlogScopeSchema>,
  ) {
    return this.backlog.preview(scopeOf(body));
  }

  /** Deletes the backlog in scope, never a mandatory notification or essential mail. */
  @Post('backlog/discard')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @SerializeOptions({ schema: backlogResultSchema })
  @ApiOperation({
    summary: 'Discard the outbox or mail backlog in a scope',
    description:
      'outbox: deletes pending notifications.deliver (and other) messages not being delivered, and dead letters, in batches; a discarded notification stays in the list, marked delivered, with no push, mail or webhook. mail: removes waiting, delayed and failed jobs. Never a mandatory notification type, essential mail or running work. Up to limit (10,000) per call: call again while more. Preview first. Audited.',
  })
  @ApiOkResponse({ standardSchema: backlogResultSchema })
  async discardBacklog(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: backlogActionSchema })
    body: z.infer<typeof backlogActionSchema>,
    @Ip() ip: string,
  ) {
    const result = await this.backlog.discard(
      body.target,
      scopeOf(body.scope),
      body.limit,
    );
    await this.audit.record(user, {
      action: 'ops.backlog-discarded',
      targetType: body.target,
      details: { scope: body.scope, ...result },
      ip,
    });
    return result;
  }

  /** Runs the failed work in scope again. */
  @Post('backlog/retry')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @SerializeOptions({ schema: backlogResultSchema })
  @ApiOperation({
    summary: 'Retry the outbox dead letters or failed mail in a scope',
    description:
      'outbox: requeues the dead letters with a fresh retry budget; mail: retries the failed jobs. The mail mode and the daily budgets still apply. Up to limit (10,000) per call: call again while more. Audited.',
  })
  @ApiOkResponse({ standardSchema: backlogResultSchema })
  async retryBacklog(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: backlogActionSchema })
    body: z.infer<typeof backlogActionSchema>,
    @Ip() ip: string,
  ) {
    const result = await this.backlog.retry(
      body.target,
      scopeOf(body.scope),
      body.limit,
    );
    await this.audit.record(user, {
      action: 'ops.backlog-retried',
      targetType: body.target,
      details: { scope: body.scope, ...result },
      ip,
    });
    return result;
  }

  /** Messages the outbox gave up on: requeued for another try (all when no ids). */
  @Post('dead-letters/requeue')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @SerializeOptions({ schema: requeuedSchema })
  @ApiOperation({ summary: 'Requeue dead letters (these ids, or all)' })
  @ApiOkResponse({ standardSchema: requeuedSchema })
  async requeue(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: idsSchema }) body: z.infer<typeof idsSchema>,
    @Ip() ip: string,
  ) {
    const requeued = await this.deadLetters.requeue(
      body.ids?.length ? body.ids : { all: true },
    );
    await this.audit.record(user, {
      action: 'outbox.dead-letters-requeued',
      details: { ids: body.ids ?? 'all', requeued },
      ip,
    });
    return { requeued };
  }

  /** Messages the outbox gave up on: deleted (all when no ids). */
  @Post('dead-letters/purge')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @SerializeOptions({ schema: purgedSchema })
  @ApiOperation({ summary: 'Delete dead letters (these ids, or all)' })
  @ApiOkResponse({ standardSchema: purgedSchema })
  async purge(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: idsSchema }) body: z.infer<typeof idsSchema>,
    @Ip() ip: string,
  ) {
    const purged = await this.deadLetters.purge(
      body.ids?.length ? body.ids : { all: true },
    );
    await this.audit.record(user, {
      action: 'outbox.dead-letters-purged',
      details: { ids: body.ids ?? 'all', purged },
      ip,
    });
    return { purged };
  }
}
