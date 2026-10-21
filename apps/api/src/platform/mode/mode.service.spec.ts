import type { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import type { MetricsService } from '../../core/metrics/metrics.service.js';
import type { OpsQueues } from '../ops/ops-queues.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { ModeService } from './mode.service.js';
import type { AppMode } from './mode.setting.js';

function setup(stored: AppMode, forced?: AppMode, withSchedule = true) {
  const state = { stored };
  const settings = {
    get: vi.fn(() => Promise.resolve(state.stored)),
    restrict: vi.fn(),
    onPlatformChange: vi.fn(),
  };
  const queues = {
    pauseAll: vi.fn(() => Promise.resolve()),
    resumeAll: vi.fn(() => Promise.resolve()),
  };
  const job = { isActive: true, stop: vi.fn(), start: vi.fn() };
  job.stop.mockImplementation(() => (job.isActive = false));
  job.start.mockImplementation(() => (job.isActive = true));
  const schedule = { getCronJobs: () => new Map([['job', job]]) };
  const service = new ModeService(
    settings as unknown as SettingsService,
    { get: () => forced } as unknown as ConfigService<never, true>,
    queues as unknown as OpsQueues,
    {
      get: () => {
        if (!withSchedule) throw new Error('not found');
        return schedule;
      },
    } as unknown as ModuleRef,
    {} as MetricsService,
  );
  return { service, state, settings, queues, job };
}

describe('ModeService', () => {
  it('reads the setting, caching it briefly', async () => {
    const { service, settings } = setup('read-only');
    expect(service.current()).toBe('normal');
    expect(await service.get()).toBe('read-only');
    await service.get();
    expect(settings.get).toHaveBeenCalledTimes(1);
  });

  it('APP_MODE wins over the stored value and refuses a new one', async () => {
    const { service, settings } = setup('normal', 'maintenance');
    expect(await service.get()).toBe('maintenance');
    const check = settings.restrict.mock.calls[0]![1] as (v: string) => unknown;
    expect(check('normal')).toMatch(/APP_MODE/);
  });

  it('a restricted mode pauses the queues and stops cron; normal undoes both', async () => {
    const { service, state, queues, job } = setup('maintenance');
    await service.refresh();
    expect(queues.pauseAll).toHaveBeenCalledTimes(1);
    expect(job.stop).toHaveBeenCalled();
    await service.refresh();
    expect(queues.pauseAll).toHaveBeenCalledTimes(1);
    state.stored = 'normal';
    await service.refresh();
    expect(queues.resumeAll).toHaveBeenCalledTimes(1);
    expect(job.start).toHaveBeenCalled();
  });

  it('keeps the last mode when the read fails', async () => {
    const { service, settings } = setup('read-only');
    await service.refresh();
    settings.get.mockRejectedValueOnce(new Error('redis away'));
    expect(await service.refresh()).toBe('read-only');
  });

  it('works without a scheduler (SCHEDULER=off, APP_ROLE=api): queues only', async () => {
    const { service, queues, job } = setup('read-only', undefined, false);
    await service.refresh();
    expect(queues.pauseAll).toHaveBeenCalledTimes(1);
    expect(job.stop).not.toHaveBeenCalled();
  });
});
