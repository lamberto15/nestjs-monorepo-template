import { Logger } from '@nestjs/common';
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
