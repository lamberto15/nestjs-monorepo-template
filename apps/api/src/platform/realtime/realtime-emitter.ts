import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type { CoreEnv } from '../../core/config/core.env.js';
import { REDIS } from '../../core/redis/redis.js';
import { REALTIME_NAMESPACE, realtimeChannelKey } from './realtime-adapter.js';

/**
 * Reaches the API's sockets from a process without a socket server: the
 * operator CLI (`pnpm ops`, a standalone application context), a script.
 * socket.io's way for that is the Redis emitter (socket.io docs, "Redis
 * adapter", Emitter): it publishes on the channels the Redis adapter of
 * every API replica listens to (the same key, realtime-adapter.ts), so a
 * password reset from the CLI ends the account's live connections as the
 * same reset through the API does. Realtime uses it only when it has no
 * server of its own.
 */
@Injectable()
export class RealtimeEmitter {
  private readonly emitter: Emitter;

  constructor(
    @Inject(REDIS) redis: Redis,
    config: ConfigService<CoreEnv, true>,
  ) {
    this.emitter = new Emitter(redis, {
      key: realtimeChannelKey(config),
    }).of(`/${REALTIME_NAMESPACE}`);
  }

  /** Every replica disconnects the sockets in these rooms (and closes them). */
  disconnect(rooms: string[]) {
    this.emitter.in(rooms).disconnectSockets(true);
  }
}
