import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { Config, CoreEnv } from '../../core/config/core.env.js';
import { REDIS, closeRedis } from '../../core/redis/redis.js';

/**
 * socket.io with the Redis adapter: an event emitted on one instance reaches
 * the clients connected to every other one. With several instances behind a
 * load balancer, clients connect with `transports: ['websocket']` (or the
 * balancer needs sticky sessions): Redis alone doesn't make polling work.
 */
class RedisIoAdapter extends IoAdapter {
  private readonly clients: Redis[];
  private readonly adapter: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext, redis: Redis, key: string) {
    super(app);
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    this.clients = [pub, sub];
    this.adapter = createAdapter(pub, sub, { key });
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options);
    server.adapter(this.adapter);
    return server;
  }

  async close(server: Server) {
    await super.close(server);
    await Promise.all(this.clients.map((client) => closeRedis(client)));
  }
}

/** The namespace of the Realtime gateway (`/realtime`). */
export const REALTIME_NAMESPACE = 'realtime';

/** The Redis channels' prefix, shared by the adapter and the emitter (realtime-emitter.ts). */
export const realtimeChannelKey = (config: Config<CoreEnv>) =>
  `${config.get('REDIS_PREFIX', { infer: true })}:socket.io`;

/** Gateways (RealtimeGateway, yours) run on socket.io, fanned out through Redis. */
export async function setupRealtime(app: INestApplication) {
  const config = app.get<Config<CoreEnv>>(ConfigService);
  app.useWebSocketAdapter(
    new RedisIoAdapter(app, app.get<Redis>(REDIS), realtimeChannelKey(config)),
  );
}
