import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { runsWorkers } from '../../core/config/core.env.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { OpsQueues } from '../ops/ops-queues.service.js';
import type { PlatformEnv } from '../platform.env.js';
import { SettingsService } from '../settings/settings.service.js';
import { APP_MODES, type AppMode, PLATFORM_MODE } from './mode.setting.js';

type CronJob = ReturnType<SchedulerRegistry['getCronJob']>;

/** How long a read of the mode is reused: the guard asks on every request. */
const CACHE_MS = 1_000;
/** How often a process looks again, with no request to ask it (workers). */
const POLL_MS = 5_000;

/**
 * The deployment's mode (`normal`, `read-only`, `maintenance`): `APP_MODE`
 * when the environment forces it, else the operators' `platform.mode`
 * setting (docs/settings.md). Kept for a second per instance and refreshed
 * at once when this instance writes it; the others see a change within a
 * second or so (SettingsService's version in Redis). A read that fails
 * keeps the mode last known, never switching a mode on or off by accident.
 *
 * Where workers run (APP_ROLE `worker` or `all`), a restricted mode also
 * pauses every BullMQ queue (BullMQ's own `pause()`: jobs wait in Redis) and
 * stops the cron jobs (@nestjs/schedule's `CronJob.stop()`), and `normal`
 * resumes both. Custom: no package ties these to a mode of the app.
 */
@Injectable()
export class ModeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Mode');
  private mode: AppMode;
  private readAt = 0;
  private reading: Promise<AppMode> | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** The side effects (queues) last applied for: undefined until the first read. */
  private applied: AppMode | undefined;
  /** The cron jobs this service stopped, to start again. */
  private readonly stopped = new Set<CronJob>();

  constructor(
    private readonly settings: SettingsService,
    private readonly config: ConfigService<PlatformEnv, true>,
    private readonly queues: OpsQueues,
    private readonly moduleRef: ModuleRef,
    private readonly metrics: MetricsService,
  ) {
    this.mode = this.forced() ?? PLATFORM_MODE.default;
    // The environment's mode can't be overridden by a stored one.
    settings.restrict(PLATFORM_MODE, () => {
      const forced = this.forced();
      return forced
        ? `The mode is forced to "${forced}" by APP_MODE; unset it to change the mode here.`
        : undefined;
    });
    settings.onPlatformChange(() => {
      this.readAt = 0;
      void this.refresh();
    });
  }

  onModuleInit() {
    this.metrics.collect(
      'app_mode',
      'The deployment mode: 1 for the current one (normal, read-only, maintenance).',
      () =>
        APP_MODES.map((mode) => ({
          labels: { mode },
          value: mode === this.mode ? 1 : 0,
        })),
      ['mode'],
    );
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  /** The last known mode, without reading anything (GET /features). */
  current(): AppMode {
    return this.mode;
  }

  /** The mode, read at most once a second. */
  async get(): Promise<AppMode> {
    if (Date.now() - this.readAt < CACHE_MS) {
      return this.mode;
    }
    return this.refresh();
  }

  /** Reads the mode now (one read at a time) and applies what follows from it. */
  refresh(): Promise<AppMode> {
    this.reading ??= this.read().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private forced(): AppMode | undefined {
    return this.config.get('APP_MODE', { infer: true });
  }

  private async read(): Promise<AppMode> {
    try {
      this.mode = this.forced() ?? (await this.settings.get(PLATFORM_MODE));
      this.readAt = Date.now();
    } catch (error) {
      // Keep the mode last known; ask again on the next request.
      this.logger.warn('Could not read the mode; keeping the last one.', {
        error: String(error),
      });
      return this.mode;
    }
    await this.apply(this.mode);
    return this.mode;
  }

  /**
   * The scheduler, where ScheduleModule is loaded (a worker; not with
   * SCHEDULER=off or APP_ROLE=api). Looked up, not injected: the module is
   * registered conditionally (core.module.ts) and isn't visible to a
   * provider's constructor.
   */
  private scheduler(): SchedulerRegistry | undefined {
    try {
      return this.moduleRef.get(SchedulerRegistry, { strict: false });
    } catch {
      return undefined;
    }
  }

  private async apply(mode: AppMode) {
    if (!runsWorkers()) {
      return;
    }
    // Cron jobs: stopped every time (one registered late is caught too).
    const schedule = this.scheduler();
    if (!schedule) {
      // nothing to stop or start
    } else if (mode === 'normal') {
      for (const job of this.stopped) job.start();
      this.stopped.clear();
    } else {
      for (const job of schedule.getCronJobs().values()) {
        if (job.isActive) {
          await job.stop();
          this.stopped.add(job);
        }
      }
    }
    if (this.applied === mode) {
      return;
    }
    try {
      if (mode === 'normal') {
        await this.queues.resumeAll();
      } else {
        await this.queues.pauseAll();
      }
      this.applied = mode;
      this.logger.log(`Mode ${mode}.`);
    } catch (error) {
      // Tried again on the next tick.
      this.logger.warn(`Could not apply the mode ${mode} to the queues.`, {
        error: String(error),
      });
    }
  }
}
