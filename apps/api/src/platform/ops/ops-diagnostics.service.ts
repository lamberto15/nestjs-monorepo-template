import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailTransport, SmtpTransport } from '@nestjs/mail';
import { StorageDisk } from '@nestjs/storage';
import type { Redis } from 'ioredis';
import type { CoreEnv } from '../../core/config/core.env.js';
import { DatabaseHealth } from '../../core/database/database-health.js';
import { redactString } from '../../core/logging/redaction.js';
import { REDIS, redisResponds } from '../../core/redis/redis.js';
import type { PlatformEnv } from '../platform.env.js';
import { OpsQueues } from './ops-queues.service.js';

/** What the diagnostics look at, in the order they are shown. */
export const DIAGNOSTIC_CHECKS = [
  'database',
  'redis',
  'workers',
  'mail',
  'storage',
  'realtime',
] as const;
export type DiagnosticCheck = (typeof DIAGNOSTIC_CHECKS)[number];

/**
 * - `ok`: answered just now.
 * - `configured`: set up, not probed by the overview (run its test).
 * - `disabled`: switched off on purpose (an environment flag).
 * - `unconfigured`: what it needs is missing, or a development stand-in runs in production.
 * - `unavailable`: set up, but it did not answer.
 */
export type DiagnosticState =
  'ok' | 'configured' | 'disabled' | 'unconfigured' | 'unavailable';

export interface Diagnostic {
  check: DiagnosticCheck;
  state: DiagnosticState;
  /** The driver or transport in use (`smtp`, `s3`): a name, never a URL or a credential. */
  driver: string | null;
  /** What went wrong, masked as in the logs and cut; null when nothing did. */
  detail: string | null;
  /** What to do about it, for the operator; null when nothing is needed. */
  hint: string | null;
  /** Whether `POST /ops/diagnostics/{check}/test` can probe it. */
  testable: boolean;
}

export interface DiagnosticTest {
  check: DiagnosticCheck;
  ok: boolean;
  durationMs: number;
  detail: string | null;
  hint: string | null;
}

/** How long one probe may take. */
const PROBE_MS = 5000;

/** Fails a probe that does not settle within PROBE_MS. */
async function within<T>(probe: Promise<T>): Promise<T> {
  return Promise.race([
    probe,
    setTimeout(PROBE_MS, undefined, { ref: false }).then(() => {
      throw new Error(`No answer within ${PROBE_MS / 1000} s.`);
    }),
  ]);
}

/** An error's message for a browser or a terminal: masked, cut, no stack. */
const describe = (error: unknown) =>
  redactString(error instanceof Error ? error.message : String(error), 300);

/**
 * The deployment's integrations as one view (docs/deployment.md,
 * "Diagnostics"): the database, Redis, the queue workers, mail, file
 * storage and realtime, each disabled, unconfigured, unavailable or fine,
 * with a hint at the fix; and a safe test per integration that touches
 * nothing a user sees (SMTP: connect, authenticate, QUIT, no mail sent;
 * storage: a probe file written, read back and deleted).
 *
 * Built from the environment's switches and driver names only: a value
 * that could be a secret (SMTP_URL, MAIL_API_KEY, the S3 keys) is never
 * read back, and an error's text is masked by the log-redaction registry.
 * The routes are the operators' (OpsController); the CLI's `diagnostics`
 * prints the same.
 */
@Injectable()
export class OpsDiagnostics {
  constructor(
    private readonly config: ConfigService<CoreEnv & PlatformEnv, true>,
    private readonly database: DatabaseHealth,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly queues: OpsQueues,
    private readonly mail: MailTransport,
    private readonly disk: StorageDisk,
  ) {}

  private get production() {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /** Every integration's state: the cheap probes run (database, Redis, workers), the others are read from the configuration. */
  async overview(): Promise<Diagnostic[]> {
    return Promise.all(DIAGNOSTIC_CHECKS.map((check) => this.state(check)));
  }

  /** Probes one integration now. Never throws for a failed probe: `ok: false` with the masked reason. */
  async test(name: string): Promise<DiagnosticTest> {
    const check = DIAGNOSTIC_CHECKS.find((known) => known === name);
    if (!check) {
      throw new NotFoundException(`No diagnostic named "${name}"`);
    }
    const state = await this.state(check);
    if (!state.testable) {
      throw new BadRequestException({
        code: 'not_testable',
        message: `${check} has no safe test with this configuration (${state.state}).`,
      });
    }
    const started = performance.now();
    let detail: string | null = null;
    try {
      await within(this.probe(check));
    } catch (error) {
      detail = describe(error);
    }
    return {
      check,
      ok: detail === null,
      durationMs: Math.round(performance.now() - started),
      detail,
      hint: detail === null ? null : HINTS[check].unavailable,
    };
  }

  private async probe(check: DiagnosticCheck) {
    switch (check) {
      case 'database':
        return this.database.ping();
      case 'redis':
      case 'realtime':
        return void (await this.redis.ping());
      case 'workers':
        if (!(await this.workerCount())) {
          throw new Error('No worker is connected to any queue.');
        }
        return;
      case 'mail':
        // Connects, authenticates and says QUIT: no message is sent.
        return (this.mail as SmtpTransport).verify();
      case 'storage': {
        const key = `ops/diagnostics/${randomUUID()}.txt`;
        try {
          await this.disk.put(key, Buffer.from('diagnostics probe'));
          await this.disk.getBuffer(key);
        } finally {
          await this.disk.delete(key);
        }
      }
    }
  }

  private async workerCount() {
    return (await this.queues.workers()).reduce(
      (sum, queue) => sum + queue.workers,
      0,
    );
  }

  private async state(check: DiagnosticCheck): Promise<Diagnostic> {
    const result = (
      state: DiagnosticState,
      driver: string | null = null,
      detail: string | null = null,
      testable = true,
    ): Diagnostic => ({
      check,
      state,
      driver,
      detail,
      hint:
        state === 'ok' || state === 'configured'
          ? null
          : (HINTS[check][state] ?? null),
      testable,
    });
    const live = async (
      driver: string | null,
      probe: () => Promise<unknown>,
    ) => {
      try {
        await within(probe());
        return result('ok', driver);
      } catch (error) {
        return result('unavailable', driver, describe(error));
      }
    };
    switch (check) {
      case 'database':
        return live('postgresql', () => this.database.ping());
      case 'redis':
        return live('redis', async () => {
          if (!(await redisResponds(this.redis))) {
            throw new Error('Redis did not answer PING.');
          }
        });
      case 'workers':
        return live('bullmq', () =>
          this.workerCount().then((count) => {
            if (!count) throw new Error('No worker is connected to any queue.');
          }),
        );
      case 'mail': {
        const transport = this.config.get('MAIL_TRANSPORT', { infer: true });
        const standIn = ['file', 'log', 'memory'].includes(transport);
        if (standIn && this.production) {
          return result('unconfigured', transport, null, false);
        }
        // Only SMTP has a check that sends nothing; the HTTP providers' keys were required at startup.
        return result('configured', transport, null, transport === 'smtp');
      }
      case 'storage': {
        const driver = this.config.get('STORAGE_DRIVER', { infer: true });
        if (driver === 'memory' && this.production) {
          return result('unconfigured', driver, null, false);
        }
        return result('configured', driver);
      }
      case 'realtime':
        if (!this.config.get('REALTIME', { infer: true })) {
          return result('disabled', null, null, false);
        }
        return live('socket.io', async () => {
          if (!(await redisResponds(this.redis))) {
            throw new Error(
              'Redis, which carries realtime events, did not answer.',
            );
          }
        });
    }
  }
}

/** What to do, by integration and state. English: the operators' (and the CLI's) text. */
const HINTS: Record<
  DiagnosticCheck,
  { unavailable: string } & Partial<Record<'disabled' | 'unconfigured', string>>
> = {
  database: {
    unavailable:
      'Check that PostgreSQL runs and DATABASE_URL points at it; `pnpm ops` and the logs say more.',
  },
  redis: {
    unavailable:
      'Check that Redis runs and REDIS_URL points at it: queues, rate limits and realtime need it.',
  },
  workers: {
    unavailable:
      'Start a worker process (APP_ROLE=worker, or all): jobs wait in Redis until one runs. With managed Redis, CLIENT LIST must be allowed for this count.',
  },
  mail: {
    unconfigured:
      'MAIL_TRANSPORT is a development stand-in in production: set it to smtp (SMTP_URL) or a provider (MAIL_API_KEY), docs/configuration.md.',
    unavailable:
      'Check SMTP_URL (host, port, TLS, user and password) and that the server accepts this host.',
  },
  storage: {
    unconfigured:
      'STORAGE_DRIVER=memory loses every file on restart: set local (STORAGE_ROOT) or s3 (S3_*), docs/configuration.md.',
    unavailable:
      'Check the S3_* settings and the credentials (write, read and delete on the bucket), or that STORAGE_ROOT is writable.',
  },
  realtime: {
    disabled:
      'REALTIME=off: clients get no live updates. Set REALTIME=on to serve /realtime.',
    unavailable:
      'Realtime events go through Redis: check REDIS_URL, then that the proxy forwards WebSocket upgrades on /realtime.',
  },
};
