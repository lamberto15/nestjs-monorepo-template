import { Logger } from '@nestjs/common';
import {
  recordTelemetryFailure,
  resetTelemetryHealth,
} from '../observability/telemetry-health.js';
import { MetricsService } from './metrics.service.js';

describe('MetricsService.collect()', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failing = () => Promise.reject(new Error('Redis is away'));

  it('serves the gauges it read', async () => {
    const metrics = new MetricsService();
    metrics.collect(
      'jobs',
      'Jobs.',
      () => [{ labels: { state: 'waiting' }, value: 3 }],
      ['state'],
    );
    metrics.collect('lag_seconds', 'Lag.', () => [{ value: 1.5 }]);

    const { body } = await metrics.scrape();
    expect(body).toMatch(/^jobs\{state="waiting"\} 3$/m);
    expect(body).toMatch(/^lag_seconds 1\.5$/m);
  });

  it('leaves a gauge whose read fails out of the scrape, labelled or not, and serves the rest', async () => {
    const metrics = new MetricsService();
    metrics.collect('queue_jobs', 'Jobs.', failing, ['queue', 'state']);
    metrics.collect('outbox_lag_seconds', 'Lag.', failing);
    metrics.collect('healthy', 'Still there.', () => [{ value: 1 }]);

    const { body } = await metrics.scrape();
    expect(body).not.toMatch(/^queue_jobs[{ ]/m);
    // Absent, not a 0: the alerts read absence as "could not be read".
    expect(body).not.toMatch(/^outbox_lag_seconds[{ ]/m);
    expect(body).toMatch(/^healthy 1$/m);
    expect(body).toMatch(/^nodejs_heap_size_limit_bytes \d+$/m);
  });

  it('drops the samples of an earlier scrape when a later read fails', async () => {
    const metrics = new MetricsService();
    let fail = false;
    metrics.collect(
      'queue_jobs',
      'Jobs.',
      () => (fail ? failing() : [{ labels: { queue: 'mail' }, value: 2 }]),
      ['queue'],
    );
    expect((await metrics.scrape()).body).toMatch(
      /^queue_jobs\{queue="mail"\} 2$/m,
    );
    fail = true;
    expect((await metrics.scrape()).body).not.toMatch(/^queue_jobs[{ ]/m);
  });
});

describe('MetricsService telemetry_rejected_total', () => {
  afterEach(resetTelemetryHealth);

  it('has every refusal series at 0 before the first refusal', async () => {
    // Prometheus' increase() needs a sample before the count: a series that
    // appears already at 1 (NestJS Observe refuses once, then pauses) would
    // never raise TelemetryRejected.
    const { body } = await new MetricsService().scrape();
    for (const target of ['observe', 'otlp']) {
      for (const status of [401, 403, 429]) {
        expect(body).toContain(
          `telemetry_rejected_total{target="${target}",status="${status}"} 0`,
        );
      }
    }
  });

  it('counts the refusals on top of that', async () => {
    const metrics = new MetricsService();
    recordTelemetryFailure('observe', 401);
    recordTelemetryFailure('otlp', 429);
    recordTelemetryFailure('otlp', 429);
    const { body } = await metrics.scrape();
    expect(body).toContain(
      'telemetry_rejected_total{target="observe",status="401"} 1',
    );
    expect(body).toContain(
      'telemetry_rejected_total{target="otlp",status="429"} 2',
    );
    expect(body).toContain(
      'telemetry_rejected_total{target="otlp",status="401"} 0',
    );
  });
});
