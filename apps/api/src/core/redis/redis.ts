import { setTimeout } from 'node:timers/promises';
import {
  Inject,
  Injectable,
  Logger,
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
    // Commands wait for a reconnect instead of failing at once (BullMQ requires it).
    maxRetriesPerRequest: null,
  };
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

/** Closes the shared connection after everything that uses it has stopped. */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    redis.on('error', (error: Error) =>
      this.logger.warn(`Redis: ${error.message}`),
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
