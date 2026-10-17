import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Param,
  type MessageEvent,
  Post,
  Sse,
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
import { map, merge, type Observable } from 'rxjs';
import { z } from 'zod';
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
  @ApiOperation({
    summary: 'Outbox stats and the latest 50 dead letters',
    description:
      'lagMs is the number to alert on: how long the oldest due message has waited. notifications.undelivered: stored notifications the worker has not delivered, though older than ten minutes.',
  })
  async state(@CurrentUser() user: UserPrincipal) {
    return {
      stats: await this.outboxRelay.stats(),
      deadLetters: await this.deadLetters.list({ limit: 50 }),
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
  @ApiOkResponse({ description: 'A stream of `data: {source, at, …}` events.' })
  events(): Observable<MessageEvent> {
    const tagged = <T extends object>(source: string) =>
      map((event: T) => ({ data: { source, at: Date.now(), ...event } }));
    return merge(
      this.workflowEvents.events$.pipe(tagged('workflow')),
      this.webhooksEvents.events$.pipe(tagged('webhooks')),
      this.outboxEvents.events$.pipe(tagged('outbox')),
      this.idempotencyEvents.events$.pipe(tagged('idempotency')),
      this.locksEvents.events$.pipe(tagged('locks')),
      this.mailEvents.events$.pipe(tagged('mail')),
      this.resilienceEvents.events$.pipe(tagged('resilience')),
    );
  }

  @Get('queues')
  @Can(OpsPolicy, 'view')
  @ApiOperation({
    summary: 'Background job queues: counts by state and the latest failures',
  })
  async queueOverview() {
    return { items: await this.queues.overview() };
  }

  /** A queue's failed jobs, run again. */
  @Post('queues/:name/retry-failed')
  @Can(OpsPolicy, 'manage')
  @HttpCode(200)
  @ApiOperation({ summary: "Retry a queue's failed jobs" })
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
  @ApiOperation({ summary: 'Requeue dead letters (these ids, or all)' })
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
  @ApiOperation({ summary: 'Delete dead letters (these ids, or all)' })
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
