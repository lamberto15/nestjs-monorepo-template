import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Counter } from 'prom-client';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import {
  type IntakeRequest,
  MAIL_EVENTS,
  type MailEventIntake,
  type MailEventsJob,
} from './mail-event.types.js';

/** The intakes by name (`ses`): each provider registers itself from its constructor. */
@Injectable()
export class MailEventIntakeRegistry {
  private readonly intakes = new Map<string, MailEventIntake>();

  register(intake: MailEventIntake) {
    if (this.intakes.has(intake.name)) {
      throw new Error(`Two mail event intakes are named "${intake.name}".`);
    }
    this.intakes.set(intake.name, intake);
  }

  find(name: string) {
    return this.intakes.get(name);
  }

  names() {
    return [...this.intakes.keys()];
  }
}

/** What the route answers. */
export interface MailEventsReceipt {
  received: true;
  /** `events` (queued), `handshake` (the provider's subscription confirmed) or `ignored`. */
  kind: 'events' | 'handshake' | 'ignored';
  /** How many events were queued (`events`), 0 otherwise. */
  events: number;
}

/**
 * Receives a provider's notification: the intake authenticates it and
 * turns it into events, which go to the `mail-events` queue (job id: the
 * provider's message id, so a redelivery that arrives while the first job
 * is kept is dropped here; the one that arrives later is a no-op in the
 * processor). The request does nothing else.
 */
@Injectable()
export class MailEventsService {
  private readonly logger = new Logger('MailEvents');
  private readonly received: Counter<'provider' | 'type'>;

  constructor(
    private readonly registry: MailEventIntakeRegistry,
    @InjectQueue(MAIL_EVENTS) private readonly queue: Queue<MailEventsJob>,
    metrics: MetricsService,
  ) {
    this.received = new Counter({
      name: 'mail_events_total',
      help: 'Bounce, complaint and delivery events mail providers reported, by provider and type (counted when received, before the queue).',
      labelNames: ['provider', 'type'] as const,
      registers: [metrics.registry],
    });
  }

  async receive(
    provider: string,
    request: IntakeRequest,
  ): Promise<MailEventsReceipt> {
    const intake = this.registry.find(provider);
    if (!intake) {
      throw new NotFoundException(`No mail provider named "${provider}".`);
    }
    const result = await intake.receive(request);
    if (result.kind !== 'events') {
      this.logger.log(`Mail notification ${result.kind}`, {
        provider,
        detail: result.detail,
      });
      return { received: true, kind: result.kind, events: 0 };
    }
    for (const event of result.events) {
      this.received.labels(provider, event.type).inc();
    }
    await this.queue.add(
      provider,
      { provider, id: result.id, events: result.events },
      // A message id is unique per notification and safe in a job id (no `:`).
      { jobId: `${provider}-${result.id.replace(/[^A-Za-z0-9_-]/g, '_')}` },
    );
    return { received: true, kind: 'events', events: result.events.length };
  }
}
