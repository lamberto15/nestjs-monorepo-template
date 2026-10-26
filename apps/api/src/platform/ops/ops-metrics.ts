import { Injectable, type OnModuleInit } from '@nestjs/common';
import { WebhookDeliveries } from '@nestjs/webhooks';
import { runsWorkers } from '../../core/config/core.env.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { OpsQueues, QUEUE_GAUGE_STATES } from './ops-queues.service.js';
import {
  MetricSnapshot,
  OutboxMetricsReader,
} from './outbox-metrics.reader.js';

/** Share webhook statistics among the gauges in a scrape. */
const oncePerScrape = <T>(read: () => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= read().finally(() => {
      setImmediate(() => (pending = undefined));
    });
    return pending;
  };
};

/**
 * The platform's gauges on core's `/metrics`, read at each scrape: jobs per
 * queue and state, the outbox and the outgoing webhooks (what /v1/ops and
 * /v1/webhook-deliveries show). They're shared state (Redis, PostgreSQL):
 * every instance reports the same values, so aggregate them with max(), not
 * sum(). The alert rules: monitoring/prometheus/alerts.yml.
 */
@Injectable()
export class OpsMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: OpsQueues,
    private readonly outbox: OutboxMetricsReader,
    private readonly webhookDeliveries: WebhookDeliveries,
  ) {}

  onModuleInit() {
    // These are deployment-wide backlogs, sampled only by worker-capable processes.
    if (!runsWorkers()) return;

    this.metrics.collect(
      'queue_jobs',
      'Background jobs per queue and state.',
      async () =>
        (await this.queues.counts()).flatMap(({ name, counts }) =>
          QUEUE_GAUGE_STATES.map((state) => ({
            labels: { queue: name, state },
            value: counts[state] ?? 0,
          })),
        ),
      ['queue', 'state'],
    );
    const outboxStats = new MetricSnapshot(() => this.outbox.read());
    this.metrics.collect(
      'outbox_undelivered',
      'Outbox messages not yet published (ready, delayed or leased).',
      async () => [{ value: (await outboxStats.get()).pending }],
    );
    this.metrics.collect(
      'outbox_dead_letters',
      'Outbox messages given up on (requeue or purge them in /v1/ops).',
      async () => [{ value: (await outboxStats.get()).deadLetters }],
    );
    this.metrics.collect(
      'outbox_lag_seconds',
      'How long the longest-waiting due outbox message has waited.',
      async () => {
        const oldestDueAt = (await outboxStats.get()).oldestDueAt;
        return [
          {
            value:
              oldestDueAt === null
                ? 0
                : Math.max(0, Date.now() - oldestDueAt) / 1000,
          },
        ];
      },
    );
    const webhookStats = oncePerScrape(() => this.webhookDeliveries.stats());
    this.metrics.collect(
      'webhook_deliveries',
      'Outgoing webhook deliveries: pending (not delivered yet), due (pending and ready for an attempt), failed (given up on, kept until pruned).',
      async () => {
        const stats = await webhookStats();
        return [
          { labels: { state: 'pending' }, value: stats.pending },
          { labels: { state: 'due' }, value: stats.due },
          { labels: { state: 'failed' }, value: stats.failed },
        ];
      },
      ['state'],
    );
    this.metrics.collect(
      'webhook_delivery_lag_seconds',
      'How long the most overdue webhook delivery has waited.',
      async () => [{ value: (await webhookStats()).lagMs / 1000 }],
    );
  }
}
