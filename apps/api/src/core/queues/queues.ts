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
import {
  type ConnectionOptions,
  type DefaultJobOptions,
  QueueBase,
  Worker,
  type WorkerOptions,
} from 'bullmq';
import type { Redis } from 'ioredis';
import { type Config, type CoreEnv, runsWorkers } from '../config/core.env.js';
import { REDIS, producerRedisOptions, redisResponds } from '../redis/redis.js';

/**
 * The worker's connection from the queues' (producer) options: the offline
 * queue back on and `maxRetriesPerRequest: null`, which a worker needs to
 * wait out a Redis outage (https://docs.bullmq.io/guide/going-to-production).
 * BullMQ forces the latter on a worker's blocking connections anyway, but
 * prints a warning for every one when the options say otherwise.
 */
export function workerConnection(
  connection: WorkerOptions['connection'],
): WorkerOptions['connection'] {
  // A client instance is the caller's own: leave it.
  if (!connection || typeof connection !== 'object' || 'status' in connection) {
    return connection;
  }
  return {
    ...connection,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
  } as ConnectionOptions;
}

/**
 * The class @nestjs/bullmq creates a `@Processor`'s worker from
 * (`BullModule.workerClass`, its documented hook): one root connection
 * serves queues and workers there, so the worker takes its own options here.
 */
export class QueueWorker extends Worker {
  constructor(
    name: string,
    processor: ConstructorParameters<typeof Worker>[1],
    options?: WorkerOptions,
  ) {
    super(
      name,
      processor,
      options && {
        ...options,
        connection: workerConnection(options.connection),
      },
    );
  }
}

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
/** Every queue's job defaults (a queue's own `defaultJobOptions` replaces them wholesale, so spread these). */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  // Finished jobs stay a while, for the ops view and debugging.
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * The mail queue's defaults. A finished mail job stays as the `jobId`
 * duplicate guard: adding a job whose id exists is a no-op, so a dead letter
 * replayed (or an abandoned add resent) while the finished job is kept
 * can't send a second mail. With the defaults' 24 h / 1,000 jobs that
 * guard lapsed quickly on a busy deployment. Mail keeps its finished jobs
 * 7 days, capped at 50,000: the price is Redis memory (a job holds the
 * rendered mail, a few KB: tens of MB at the cap), and the cap, not the
 * age, binds only above ~7,000 mails a day. Not forever: an idempotency
 * table would cost a write per mail for a replay that comes within days.
 */
export const MAIL_JOB_OPTIONS: DefaultJobOptions = {
  ...DEFAULT_JOB_OPTIONS,
  removeOnComplete: { age: 7 * 24 * 3600, count: 50_000 },
};

export const queueRoot = () => {
  BullModule.workerClass = QueueWorker;
  return BullModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: Config<CoreEnv>) => ({
      // The same Redis (and Sentinel failover) as the rest of the app. The
      // queues (producers) fail fast; BullMQ makes the connections of the
      // workers it creates from these options block and wait for Redis
      // (maxRetriesPerRequest: null), as they must.
      connection: producerRedisOptions(config) as ConnectionOptions,
      prefix: `${config.get('REDIS_PREFIX', { infer: true })}:bull`,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    extraOptions: { manualRegistration: true },
  });
};

/** The variable that sets a queue's concurrency: `data-transfers` is `QUEUE_CONCURRENCY_DATA_TRANSFERS`. */
export const queueConcurrencyVariable = (queue: string) =>
  `QUEUE_CONCURRENCY_${queue.toUpperCase().replaceAll('-', '_')}`;

/**
 * Sets each worker's concurrency from its queue's variable (each declared
 * with its queue's group: core, iam or platform; the groups' rule keeps
 * core from importing them, so the name is built from the queue's). A
 * queue without a variable keeps its `@Processor` value. `@Processor`
 * options are static decorator arguments, so the deployment's value is set
 * on the running worker instead: `concurrency` is a settable property of
 * BullMQ's Worker (https://docs.bullmq.io/guide/workers/concurrency).
 */
export function applyQueueConcurrency(
  workers: readonly Pick<Worker, 'name' | 'concurrency'>[],
  read: (variable: string) => unknown,
) {
  for (const worker of workers) {
    const value = read(queueConcurrencyVariable(worker.name));
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
      worker.concurrency = value;
    }
  }
}

/**
 * Makes `queue.close()` survive a producer connection that is down. A
 * producer has no offline queue, so with Redis unreachable its QUIT is
 * rejected ("Stream isn't writeable and enableOfflineQueue options is
 * false") where an offline-queued one would just disconnect; BullMQ passes
 * that error on, and @nestjs/bullmq's shutdown with it. Redis being gone,
 * there is nothing to quit: the connection is dropped (which also ends its
 * reconnect loop, so the process can exit).
 */
export function closeWhenRedisIsDown(
  queue: Pick<QueueBase, 'close' | 'getBackend'>,
) {
  const close = queue.close.bind(queue);
  queue.close = async () => {
    try {
      await close();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('enableOfflineQueue')
      ) {
        throw error;
      }
      // Not `queue.disconnect()`: it waits for the client's 'end', which a
      // client that is reconnecting only emits after its next attempt.
      const backend = queue.getBackend() as unknown as {
        connection: { client: Promise<{ disconnect(): void }> };
      };
      (await backend.connection.client).disconnect();
    }
  };
}

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
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    for (const queue of this.clients().others) {
      closeWhenRedisIsDown(queue);
    }
    if (runsWorkers()) {
      this.registrar.register();
      applyQueueConcurrency(this.clients().workers, (key) =>
        this.config.get<unknown>(key),
      );
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
    // Connection lost (reconnecting): BullModule's close() of the queues is
    // left to run, but only because closeWhenRedisIsDown() (onModuleInit)
    // wraps it: the producers have no offline queue, so ioredis rejects their
    // QUIT ("Stream isn't writeable…", Redis.js) instead of disconnecting, and
    // unwrapped that leaves the reconnect loop running and the shutdown
    // failing. Do not remove the wrapper. disconnect() here would wait for a
    // ready connection, for ever. Connected but silent: the QUIT would wait
    // for a reply, so disconnect.
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
