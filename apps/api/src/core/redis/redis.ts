import { setTimeout } from 'node:timers/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis, type RedisOptions } from 'ioredis';
import type { Config, CoreEnv } from '../config/core.env.js';

/** The app's Redis connection (ioredis). Keys are prefixed with `REDIS_PREFIX:`. */
export const REDIS = Symbol('REDIS');

/**
 * REDIS_URL (or REDIS_SENTINELS) as ioredis connection options, shared by
 * every client: the app's, the socket.io adapter's, BullMQ's (which takes a
 * `prefix` instead of a key prefix). `rediss://` turns TLS on; the path is
 * the database number. REDIS_PASSWORD, when set, replaces the URL's password.
 */
export function redisOptions(config: Config<CoreEnv>): RedisOptions {
  const url = new URL(config.get('REDIS_URL', { infer: true }));
  const sentinels = config.get('REDIS_SENTINELS', { infer: true });
  return {
    ...(sentinels.length > 0
      ? {
          sentinels: sentinels.map((sentinel) => {
            const [host, port] = sentinel.split(':');
            return { host, port: Number(port || 26379) };
          }),
          name: config.get('REDIS_SENTINEL_NAME', { infer: true }),
        }
      : { host: url.hostname, port: Number(url.port || 6379) }),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password:
      config.get('REDIS_PASSWORD', { infer: true }) ??
      (url.password ? decodeURIComponent(url.password) : undefined),
    db: Number(url.pathname.slice(1) || 0),
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Commands wait for a reconnect instead of failing at once (BullMQ's
    // workers require it; BullMQ also forces it on every blocking
    // connection of a Worker or QueueEvents it creates from these options).
    maxRetriesPerRequest: null,
  };
}

/**
 * How long a producer command is retried across reconnects before it fails.
 * One: a command in flight when the connection drops fails after a single
 * reconnect attempt instead of waiting for Redis for ever.
 */
export const PRODUCER_MAX_RETRIES_PER_REQUEST = 1;

/**
 * The connection options of BullMQ's `Queue` instances (what `queue.add()`
 * runs on), as BullMQ's production guide recommends for producers: no
 * offline queue, so a command issued while Redis is unreachable is rejected
 * at once instead of being buffered and sent when Redis returns (a request
 * that gave up must not leave a job that runs later), and a bounded
 * `maxRetriesPerRequest`. Workers keep `redisOptions()`'s `null`: they must
 * wait for Redis (https://docs.bullmq.io/guide/going-to-production).
 */
export function producerRedisOptions(config: Config<CoreEnv>): RedisOptions {
  return {
    ...redisOptions(config),
    enableOfflineQueue: false,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES_PER_REQUEST,
  };
}

/** Thrown by `redisWithin()` when Redis can't answer in time. */
export class RedisUnavailableError extends Error {}

/**
 * Runs one Redis read for a caller that must not wait for Redis: the shared
 * client queues commands until Redis is back (`maxRetriesPerRequest:
 * null`), so a client that is not connected fails at once (the command is
 * never queued), and a connected one that doesn't answer within `timeoutMs`
 * fails then. Callers fall back to a cached or default value.
 */
export async function redisWithin<T>(
  client: Pick<Redis, 'status'>,
  read: () => Promise<T>,
  timeoutMs = 500,
): Promise<T> {
  if (client.status !== 'ready') {
    throw new RedisUnavailableError(`Redis is ${client.status}`);
  }
  const gaveUp = Symbol('timeout');
  const result = await Promise.race([
    read(),
    // ref: false, so a pending timer never keeps the process alive.
    setTimeout(timeoutMs, gaveUp, { ref: false }),
  ]);
  if (result === gaveUp) {
    throw new RedisUnavailableError(`Redis took over ${timeoutMs} ms`);
  }
  return result as T;
}

/**
 * Closes an ioredis client without ever hanging a shutdown. `quit()` sends
 * QUIT after the commands already queued; with `maxRetriesPerRequest: null`,
 * those wait for a reconnect that never comes once Redis is gone, and so
 * does the QUIT (seen: SIGTERM after Redis was removed, the process never
 * exited). So: connected, `quit()` lets pending replies arrive, for at most
 * `timeoutMs`; not connected (reconnecting, connecting), nothing can be
 * flushed anyway and `disconnect()` closes at once, dropping the queue and
 * stopping the reconnect loop. ioredis offers no quit-with-timeout itself.
 */
export async function closeRedis(client: Redis, timeoutMs = 2000) {
  if (client.status === 'ready') {
    const gaveUp = Symbol('timeout');
    const result = await Promise.race([
      client.quit().catch(() => gaveUp),
      // ref: false, so a finished quit doesn't leave the process waiting for it.
      setTimeout(timeoutMs, gaveUp, { ref: false }),
    ]);
    if (result !== gaveUp) {
      return;
    }
  }
  if (client.status !== 'end') {
    client.disconnect();
  }
}

/**
 * Whether Redis answers a PING within `timeoutMs`: connected and responsive,
 * not just a socket that is still open to a server that stopped answering.
 */
export async function redisResponds(client: Redis, timeoutMs = 2000) {
  if (client.status !== 'ready') {
    return false;
  }
  return Promise.race([
    client.ping().then(
      () => true,
      () => false,
    ),
    setTimeout(timeoutMs, false, { ref: false }),
  ]);
}

/**
 * The oldest Redis the app runs on. `EXPIRE … NX` (the bot-protection
 * counters' fixed window, captcha.service.ts; the usage counters,
 * usage.service.ts) exists since Redis 7.0: on an older server the command
 * fails with a syntax error, and every guarded sign-in with it.
 */
export const MIN_REDIS_VERSION = '7.0.0';

/** The `redis_version` an `INFO server` answer names, or undefined (a proxy, a server that hides it). */
export function redisVersionOf(info: string) {
  return /^redis_version:(\S+)/m.exec(info)?.[1];
}

/** Whether a `redis_version` (`7.2.4`, `8.0-rc1`) is MIN_REDIS_VERSION or newer. */
export function redisVersionSupported(version: string) {
  const parts = (value: string) =>
    value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const actual = parts(version);
  const minimum = parts(MIN_REDIS_VERSION);
  for (let i = 0; i < minimum.length; i++) {
    if ((actual[i] ?? 0) !== minimum[i]) {
      return (actual[i] ?? 0) > minimum[i];
    }
  }
  return true;
}

/**
 * Stops the start when the server is older than MIN_REDIS_VERSION: a clear
 * message now, instead of a syntax error on the first guarded sign-in. A
 * server that doesn't answer within `timeoutMs` (down, reconnecting: the
 * commands wait for it) or names no version is left alone, with a warning:
 * the check is a convenience, not a gate on availability.
 */
export async function assertRedisVersion(
  client: Pick<Redis, 'info'>,
  warn: (message: string) => void,
  timeoutMs = 2000,
) {
  const info = await Promise.race([
    client.info('server').catch((error: Error) => error),
    setTimeout(timeoutMs, undefined, { ref: false }),
  ]);
  if (info === undefined) {
    warn(`Redis version not checked: no answer within ${timeoutMs} ms`);
    return;
  }
  if (info instanceof Error) {
    warn(`Redis version not checked: ${info.message}`);
    return;
  }
  const version = redisVersionOf(info);
  if (!version) {
    warn('Redis version not checked: INFO server names none');
    return;
  }
  if (!redisVersionSupported(version)) {
    throw new Error(
      `Redis ${version} is too old: the app needs Redis ${MIN_REDIS_VERSION} or newer (EXPIRE NX; docs/deployment.md, "Redis"). Upgrade the server REDIS_URL points at.`,
    );
  }
}

/** Checks the server's version at start, and closes the shared connection after everything that uses it has stopped. */
@Injectable()
export class RedisLifecycle
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    redis.on('error', (error: Error) =>
      this.logger.warn(`Redis: ${error.message}`),
    );
  }

  async onApplicationBootstrap() {
    await assertRedisVersion(this.redis, (message) =>
      this.logger.warn(message),
    );
  }

  async onApplicationShutdown() {
    await closeRedis(this.redis);
  }
}

export const redisProvider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: Config<CoreEnv>) => {
    return new Redis({
      ...redisOptions(config),
      keyPrefix: `${config.get('REDIS_PREFIX', { infer: true })}:`,
    });
  },
};
