import {
  applyQueueConcurrency,
  closeWhenRedisIsDown,
  consumesQueue,
  DEFAULT_JOB_OPTIONS,
  MAIL_JOB_OPTIONS,
  queueConcurrencyVariable,
  workerConnection,
} from './queues.js';
import { producerRedisOptions } from '../redis/redis.js';
import type { Config, CoreEnv } from '../config/core.env.js';

const worker = (name: string, concurrency: number) => ({ name, concurrency });

describe('applyQueueConcurrency', () => {
  it('sets a worker from the variable named after its queue', () => {
    const data = worker('data-transfers', 2);
    const mail = worker('mail', 5);
    const values: Record<string, unknown> = {
      QUEUE_CONCURRENCY_DATA_TRANSFERS: 1,
      QUEUE_CONCURRENCY_MAIL: 8,
    };
    applyQueueConcurrency([data, mail], (key) => values[key]);
    expect(data.concurrency).toBe(1);
    expect(mail.concurrency).toBe(8);
  });

  it('keeps the processor value of a queue without a variable', () => {
    const other = worker('thumbnails', 3);
    applyQueueConcurrency([other], () => undefined);
    expect(other.concurrency).toBe(3);
  });

  it('names the variable after the queue', () => {
    expect(queueConcurrencyVariable('attachment-scan')).toBe(
      'QUEUE_CONCURRENCY_ATTACHMENT_SCAN',
    );
  });
});

describe('consumesQueue', () => {
  it('takes every queue when neither list is set', () => {
    expect(consumesQueue('mail', {})).toBe(true);
  });

  it('splits the queues between a light and a heavy worker', () => {
    const heavy = 'data-transfers, documents';
    const light = { WORKER_QUEUES_EXCLUDE: heavy };
    expect(consumesQueue('mail', light)).toBe(true);
    expect(consumesQueue('documents', light)).toBe(false);
    const only = { WORKER_QUEUES: heavy };
    expect(consumesQueue('data-transfers', only)).toBe(true);
    expect(consumesQueue('mail', only)).toBe(false);
  });
});

describe('mail queue retention', () => {
  it('keeps finished mail jobs (the jobId duplicate guard) longer than the default', () => {
    const mail = MAIL_JOB_OPTIONS.removeOnComplete as {
      age: number;
      count: number;
    };
    const base = DEFAULT_JOB_OPTIONS.removeOnComplete as {
      age: number;
      count: number;
    };
    expect(mail.age).toBe(7 * 24 * 3600);
    expect(mail.age).toBeGreaterThan(base.age);
    expect(mail.count).toBeGreaterThan(base.count);
  });

  it('keeps the other defaults, which a queue-level option would replace', () => {
    expect(MAIL_JOB_OPTIONS.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);
    expect(MAIL_JOB_OPTIONS.backoff).toEqual(DEFAULT_JOB_OPTIONS.backoff);
    expect(MAIL_JOB_OPTIONS.removeOnFail).toEqual(
      DEFAULT_JOB_OPTIONS.removeOnFail,
    );
  });
});

describe('worker connection', () => {
  const config = {
    get: (key: string) =>
      ({ REDIS_URL: 'redis://localhost:6379', REDIS_SENTINELS: [] })[key],
  } as unknown as Config<CoreEnv>;

  it('takes the producer options back to waiting for Redis', () => {
    const producer = producerRedisOptions(config);
    expect(producer.enableOfflineQueue).toBe(false);
    expect(workerConnection(producer as never)).toMatchObject({
      host: 'localhost',
      port: 6379,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
  });
});

describe('closing a producer queue with Redis down', () => {
  const offline = new Error(
    "Stream isn't writeable and enableOfflineQueue options is false",
  );

  it('drops the connection instead of failing the shutdown', async () => {
    const disconnect = vi.fn();
    const queue = {
      close: vi.fn().mockRejectedValue(offline),
      getBackend: () => ({
        connection: { client: Promise.resolve({ disconnect }) },
      }),
    };
    closeWhenRedisIsDown(queue as never);
    await expect(queue.close()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('passes on any other failure', async () => {
    const queue = {
      close: vi.fn().mockRejectedValue(new Error('boom')),
      getBackend: vi.fn(),
    };
    closeWhenRedisIsDown(queue as never);
    await expect(queue.close()).rejects.toThrow('boom');
  });
});
