import { Global, Module } from '@nestjs/common';
import { REDIS, RedisLifecycle, redisProvider } from './redis.js';

/** The shared Redis connection, injected with `@Inject(REDIS)`. */
@Global()
@Module({
  providers: [redisProvider, RedisLifecycle],
  exports: [REDIS],
})
export class RedisModule {}
