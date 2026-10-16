import { setTimeout } from 'node:timers/promises';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import {
  BullModule,
  BullRegistrar,
  QueueEventsHost,
  WorkerHost,
} from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { type ConnectionOptions, QueueBase, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { type Config, type CoreEnv, runsWorkers } from '../config/core.env.js';
import { REDIS, redisOptions, redisResponds } from '../redis/redis.js';

/**
 * BullMQ on Redis (@nestjs/bullmq): work that doesn't belong in a request
 * (mail, exports, imports, file processing), with retries and backoff, on
 * whichever worker is free. Keys live under `REDIS_PREFIX:bull`.
 *
 * Producers (`@InjectQueue(name)`, `queue.add()`) work in every process;
 * consumers (`@Processor`) only where the role runs workers (APP_ROLE
 * `worker` or `all`): BullModule registers them manually, below.
 *
 * Queue, outbox or workflow? A change that must trigger something reliably
 * goes through the outbox (same transaction); a multi-step process that
 * waits for days is a workflow; heavy or slow work started on demand is a
 * queue job.
 */
export const queueRoot = () =>
  BullModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: Config<CoreEnv>) => ({
      // The same Redis (and Sentinel failover) as the rest of the app.
      connection: redisOptions(config) as ConnectionOptions,
      prefix: `${config.get('REDIS_PREFIX', { infer: true })}:bull`,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        // Finished jobs stay a while, for the ops view and debugging.
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
    extraOptions: { manualRegistration: true },
  });

/**
 * Starts the consumers (and queue events) where this process runs workers,
 * and stops them on shutdown even when Redis is gone.
 */
@Injectable()
export class QueueWorkers implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger('Queues');

  constructor(
    private readonly registrar: BullRegistrar,
    private readonly discovery: DiscoveryService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    if (runsWorkers()) {
      this.registrar.register();
    }
  }

  /**
   * @nestjs/bullmq closes its workers in `onApplicationShutdown`, after Nest's
   * dispose() has closed the HTTP server and socket.io (its Redis adapter's
   * connections included). A job still running then finishes into closed
   * clients: its realtime emit is published on a closed connection, which
   * @socket.io/redis-adapter doesn't catch (an unhandled "Connection is
   * closed." rejection). So the workers are closed here, before dispose():
   * `close()` waits for their running jobs while everything they use is
   * still open (BullModule's own close afterwards returns the same promise).
   *
   * With Redis gone (or no longer answering), none of that settles (the QUIT
   * waits for a reconnect, or for a reply), and the process never exits. So
   * when Redis doesn't answer a PING within 2 s, the workers are closed with
   * `close(true)` (BullMQ's force: no waiting for jobs, connections dropped)
   * and the others are `disconnect()`ed, which ends their pending QUITs.
   * Running jobs can't be handed back without Redis: they turn stalled and
   * run again on another worker.
   */
  async beforeApplicationShutdown() {
    const { workers, others } = this.clients();
    if (workers.length + others.length === 0) {
      return;
    }
    if (await redisResponds(this.redis)) {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      return;
    }
    this.logger.warn(
      `Redis doesn't answer: closing ${workers.length} queue workers without waiting for their jobs.`,
    );
    // Connection lost (reconnecting): BullModule's close() needs no help for
    // queues, a QUIT with nothing queued disconnects at once; and
    // disconnect() would wait for a ready connection, for ever. Connected
    // but silent: the QUIT would wait for a reply, so disconnect.
    const silent = this.redis.status === 'ready';
    await Promise.race([
      Promise.allSettled([
        ...workers.map((worker) => worker.close(true)),
        ...(silent ? others.map((client) => client.disconnect()) : []),
      ]),
      setTimeout(2000, undefined, { ref: false }),
    ]);
  }

  /** The running workers, and the queues and queue-event listeners. */
  private clients() {
    const workers: Worker[] = [];
    const others: QueueBase[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof WorkerHost && instance['_worker']) {
        workers.push(instance.worker);
      } else if (
        instance instanceof QueueEventsHost &&
        instance['_queueEvents']
      ) {
        others.push(instance.queueEvents);
      } else if (instance instanceof QueueBase) {
        others.push(instance);
      }
    }
    return { workers, others };
  }
}
