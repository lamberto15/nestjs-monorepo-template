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
import { redactValue } from '../../core/logging/redaction.js';
import { opsEvent } from './ops-events.js';
import {
  opsEventSchema,
  outboxStateSchema,
  purgedSchema,
  queueOverviewSchema,
  requeuedSchema,
  retriedSchema,
  type OpsEvent,
} from './ops.schemas.js';
import { OpsPolicy } from './ops.policy.js';
import { OpsQueues } from './ops-queues.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import { OperatorOnly } from '../../iam/auth/operator-only.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

const idsSchema = z.object({ ids: z.array(z.string()).max(1000).optional() });

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
  ) {}

  @Get('outbox')
  @Can(OpsPolicy, 'view')
  @SerializeOptions({ schema: outboxStateSchema })
  @ApiOperation({
    summary: 'Outbox stats and the latest 50 dead letters',
    description:
      'lagMs is the number to alert on: how long the oldest due message has waited. notifications.undelivered: stored notifications the worker has not delivered, though older than ten minutes. Errors, payloads and headers are masked as in the logs and cut; no stack traces.',
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
