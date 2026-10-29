import { WebhookDeliveries } from '@nestjs/webhooks';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { OpsMetrics } from './ops-metrics.js';
import { OpsQueues } from './ops-queues.service.js';
import { OutboxMetricsReader } from './outbox-metrics.reader.js';

describe('OpsMetrics process roles', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { role: 'api', enabled: false },
    { role: 'worker', enabled: true },
    { role: 'all', enabled: true },
  ])(
    'registers shared backlog gauges for APP_ROLE=$role: $enabled',
    ({ role, enabled }) => {
      vi.stubEnv('APP_ROLE', role);
      const collect = vi.fn();
      const metrics = { collect } as unknown as MetricsService;
      const opsMetrics = new OpsMetrics(
        metrics,
        {} as OpsQueues,
        {} as OutboxMetricsReader,
        {} as WebhookDeliveries,
      );

      opsMetrics.onModuleInit();

      if (enabled) {
        expect(collect).toHaveBeenCalledWith(
          'outbox_undelivered',
          expect.any(String),
          expect.any(Function),
        );
        expect(collect).toHaveBeenCalledWith(
          'outbox_dead_letters',
          expect.any(String),
          expect.any(Function),
        );
        expect(collect).toHaveBeenCalledWith(
          'queue_oldest_waiting_seconds',
          expect.any(String),
          expect.any(Function),
          ['queue'],
        );
        expect(collect).toHaveBeenCalledWith(
          'outbox_undelivered_by_topic',
          expect.any(String),
          expect.any(Function),
          ['topic'],
        );
        expect(collect).toHaveBeenCalledWith(
          'outbox_lag_seconds',
          expect.any(String),
          expect.any(Function),
        );
      } else {
        expect(collect).not.toHaveBeenCalled();
      }
    },
  );
});
