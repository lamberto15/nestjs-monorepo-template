import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpException, HttpStatus, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AUTHENTICATION_MODULE_OPTIONS,
  type AuthenticationModuleOptions,
  PasswordHasher,
  type PasswordHasherOptions,
} from '@nestjs/authentication';
import { BulkheadFullError, BulkheadPolicy } from '@nestjs/resilience';
import { Counter } from 'prom-client';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import type { IamEnv } from '../iam.env.js';

/** The bulkhead's name (its events and errors). */
export const PASSWORD_HASHING = 'password-hashing';

/**
 * The scrypt parameters of the process's PasswordHasher, over
 * AuthenticationModule's `password` option. Empty (and no option): the
 * package's defaults (N = 2^17, r = 8, p = 1, the OWASP minimum: 128 MiB and
 * ~0.4 s of CPU per hash). The e2e tests make it `{ logN: 10 }`.
 */
export const PASSWORD_HASHER_PARAMS = Symbol('PASSWORD_HASHER_PARAMS');

export interface PasswordHashLimits {
  /** Hashes (and verifications) running at once in this process. */
  concurrency: number;
  /** Hashes allowed to wait for a slot; beyond that, refused at once. */
  maxQueue: number;
  /** Longest one waits for a slot before it's refused. */
  queueTimeoutMs: number;
}

export const passwordHashLimits = (
  config: ConfigService<IamEnv, true>,
): PasswordHashLimits => ({
  concurrency: config.get('PASSWORD_HASH_CONCURRENCY', { infer: true }),
  maxQueue: config.get('PASSWORD_HASH_MAX_QUEUE', { infer: true }),
  queueTimeoutMs: config.get('PASSWORD_HASH_QUEUE_TIMEOUT_MS', { infer: true }),
});

/**
 * How many password hashes this process runs at once. scrypt is
 * memory-hard: each hash allocates 128·N·r bytes (128 MiB with the default
 * parameters) outside the V8 heap, on the libuv threadpool, which runs four
 * at once (UV_THREADPOOL_SIZE). A burst of sign-ins took four of those, 512
 * MiB on top of the heap, and the container's memory limit killed the
 * replica. So at most `concurrency` hashes run (2: 256 MiB), the next ones
 * wait in order, and past `maxQueue` waiting or `queueTimeoutMs` of waiting
 * they're refused: 503 `server_busy` with Retry-After, never an unbounded
 * pile of requests. Sizing: docs/deployment.md, "Resource limits".
 *
 * @nestjs/resilience's BulkheadPolicy is the limiter (slots, a FIFO queue,
 * its bound and timeout); used inside a service, not as a route decorator,
 * since every route that checks or sets a password shares the one budget.
 */
export class PasswordHashLimiter {
  readonly bulkhead: BulkheadPolicy;
  /**
   * The most hashes that ever ran at once in this process: the e2e test
   * checks it against the limit.
   */
  peak = 0;
  private readonly rejected?: Counter<'reason'>;
  /** Set inside `run()`: this async context holds a slot already. */
  private readonly holding = new AsyncLocalStorage<true>();

  constructor(
    readonly limits: PasswordHashLimits,
    metrics?: MetricsService,
  ) {
    this.bulkhead = new BulkheadPolicy({
      name: PASSWORD_HASHING,
      maxConcurrent: limits.concurrency,
      maxQueue: limits.maxQueue,
      queueTimeout: limits.queueTimeoutMs,
    });
    if (metrics) {
      metrics.collect(
        'password_hashes_in_flight',
        'Password hashes (scrypt) running in this process; at most PASSWORD_HASH_CONCURRENCY.',
        () => [{ value: this.bulkhead.active }],
      );
      metrics.collect(
        'password_hashes_queued',
        'Password hashes waiting for a slot in this process.',
        () => [{ value: this.bulkhead.queued }],
      );
      this.rejected = new Counter({
        name: 'password_hashes_rejected_total',
        help: 'Password hashes refused (503 server_busy): the queue full, or the wait too long.',
        labelNames: ['reason'] as const,
        registers: [metrics.registry],
      });
      // Both series from the start: the first refusal after a start shows in increase().
      for (const reason of ['full', 'queue-timeout']) {
        this.rejected.inc({ reason }, 0);
      }
    }
  }

  /**
   * Runs `derive` once a slot is free. None free in time, or the queue
   * full: 503 `server_busy` with Retry-After, as `database_busy` (the
   * request was fine, the process is at its hashing budget; clients and
   * load balancers retry, the log has a warning). An HttpException, not the
   * BulkheadFullError, which @nestjs/resilience's interceptor would answer
   * as `BULKHEAD_FULL` without Retry-After.
   *
   * Re-entrant: inside `run()` (in the same async context) a nested `run()`
   * uses the slot already held instead of waiting for another, which would
   * deadlock. So a flow that must not fail after an irreversible step (a
   * reset link consumed before the new password is hashed) reserves the
   * slot first: `limiter.run(() => passwordReset.reset(…))`. The reserved
   * flow derives one hash at a time.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.holding.getStore()) {
      return work();
    }
    try {
      return await this.bulkhead.execute(() => {
        this.peak = Math.max(this.peak, this.bulkhead.active);
        return this.holding.run(true, work);
      });
    } catch (error) {
      if (error instanceof BulkheadFullError) {
        this.rejected?.inc({ reason: error.reason });
        throw new HttpException(
          {
            message: 'The service is busy: try again shortly.',
            code: 'server_busy',
            retryAfter: 1,
          },
          HttpStatus.SERVICE_UNAVAILABLE,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

type Derive = (...args: unknown[]) => Promise<Buffer>;

/**
 * The package's PasswordHasher (same parameters, same hashes: every stored
 * one keeps verifying), with each scrypt derivation run under the limiter.
 *
 * The seam is `derive()`, the package's one expensive step: `hash()`,
 * `verify()` and the dummy hash for unknown users each call it exactly
 * once. The package types it private, hence the cast. Wrapping `hash()` and
 * `verify()` instead would nest: `verify()` calls `hash()` (the dummy) and
 * itself (an unparseable hash), so a call holding a slot would wait for
 * another, and enough of them would wait for each other until they time out.
 */
export class BoundedPasswordHasher extends PasswordHasher {
  constructor(
    options: PasswordHasherOptions,
    readonly limiter: PasswordHashLimiter,
  ) {
    super(options);
    const self = this as unknown as { derive: Derive };
    const derive = self.derive;
    if (typeof derive !== 'function') {
      // A new @nestjs/authentication without it: fail at boot, never run unbounded.
      throw new Error(
        'PasswordHasher has no derive(): @nestjs/authentication changed, update iam/account/password-hashing.ts',
      );
    }
    self.derive = (...args) => limiter.run(() => derive.apply(this, args));
  }
}

/**
 * Replaces the package's PasswordHasher inside AuthenticationModule (its
 * SignInService and PasswordResetService use it too), not only the app's
 * copy: a dynamic module's providers are registered after the module's own,
 * so this one wins the token (iam.module.ts adds it).
 */
export const boundedPasswordHasher: Provider = {
  provide: PasswordHasher,
  inject: [
    AUTHENTICATION_MODULE_OPTIONS,
    PASSWORD_HASHER_PARAMS,
    PasswordHashLimiter,
  ],
  // The module's `password` option, as the package's own provider reads it,
  // under PASSWORD_HASHER_PARAMS (the tests' cheaper parameters).
  useFactory: (
    options: AuthenticationModuleOptions | undefined,
    params: PasswordHasherOptions,
    limiter: PasswordHashLimiter,
  ) => new BoundedPasswordHasher({ ...options?.password, ...params }, limiter),
};

export const passwordHashingProviders: Provider[] = [
  { provide: PASSWORD_HASHER_PARAMS, useValue: {} },
  {
    provide: PasswordHashLimiter,
    inject: [ConfigService, MetricsService],
    useFactory: (
      config: ConfigService<IamEnv, true>,
      metrics: MetricsService,
    ) => new PasswordHashLimiter(passwordHashLimits(config), metrics),
  },
];
