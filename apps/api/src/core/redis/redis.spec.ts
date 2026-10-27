import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import {
  assertRedisVersion,
  closeRedis,
  MIN_REDIS_VERSION,
  producerRedisOptions,
  redisOptions,
  RedisUnavailableError,
  redisResponds,
  redisVersionOf,
  redisVersionSupported,
  redisWithin,
} from './redis.js';
import type { Config, CoreEnv } from '../config/core.env.js';

/**
 * Shutdown with Redis gone must not hang: closeRedis() and redisResponds()
 * against a port nothing listens on (Redis removed) and against a server
 * that accepts connections but never answers (Redis frozen).
 */
describe('closing Redis clients at shutdown', () => {
  let silent: Server;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    silent = createServer((socket) => sockets.push(socket));
    silent.listen(0, '127.0.0.1');
    await once(silent, 'listening');
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.destroy());
    silent.close();
    await once(silent, 'close');
  });

  /** A port that was just free: connections are refused. */
  async function closedPort() {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');
    return port;
  }

  it('closes at once a client that is reconnecting, with a command queued', async () => {
    const client = new Redis({
      port: await closedPort(),
      host: '127.0.0.1',
      // As the app's clients: commands wait for a reconnect.
      maxRetriesPerRequest: null,
      retryStrategy: () => 50,
    });
    client.on('error', () => undefined);
    void client.get('key').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.status).not.toBe('ready');
    expect(await redisResponds(client, 200)).toBe(false);

    const started = Date.now();
    await closeRedis(client, 5000);
    expect(Date.now() - started).toBeLessThan(500);
    // And it stops trying to reconnect: nothing keeps the process alive.
    let attempts = 0;
    client.on('connecting', () => attempts++);
    client.on('reconnecting', () => attempts++);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(attempts).toBe(0);
  });

  it('gives up on QUIT after the timeout when the server never answers', async () => {
    const { port } = silent.address() as AddressInfo;
    const client = new Redis({
      port,
      host: '127.0.0.1',
      maxRetriesPerRequest: null,
      // No handshake: ready as soon as the socket connects, as a client is
      // when its server freezes (the server here never answers anything).
      protocol: 2,
      disableClientInfo: true,
      enableReadyCheck: false,
    });
    client.on('error', () => undefined);
    await once(client, 'ready');
    expect(await redisResponds(client, 200)).toBe(false);

    const started = Date.now();
    await closeRedis(client, 200);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
    // The socket closes (asynchronously) instead of waiting for a reply.
    if (client.status !== 'end') {
      await once(client, 'end');
    }
  });
});

/**
 * The server must be Redis 7.0 or newer (EXPIRE NX): too old stops the
 * start with a message naming the versions; no answer, or no version in
 * the answer, only warns, since the commands wait for Redis anyway.
 */
describe('the Redis version check at start', () => {
  const info = (body: string) =>
    ({ info: async () => body }) as unknown as Pick<Redis, 'info'>;
  const server = (version: string) =>
    info(`# Server\r\nredis_version:${version}\r\nredis_mode:standalone\r\n`);

  it('reads redis_version out of INFO server', () => {
    expect(
      redisVersionOf('# Server\r\nredis_version:7.2.4\r\nos:Linux\r\n'),
    ).toBe('7.2.4');
    expect(redisVersionOf('# Server\r\nos:Linux\r\n')).toBeUndefined();
  });

  it('accepts 7.0 and newer, refuses older', () => {
    for (const version of ['7.0.0', '7.0.15', '7.2.4', '8.0-rc1', '8.10.0']) {
      expect(redisVersionSupported(version), version).toBe(true);
    }
    for (const version of ['6.2.14', '6.0.0', '5.0.7', '2.8.4']) {
      expect(redisVersionSupported(version), version).toBe(false);
    }
    expect(MIN_REDIS_VERSION).toBe('7.0.0');
  });

  it('stops the start on an old server, naming both versions', async () => {
    const warnings: string[] = [];
    await expect(
      assertRedisVersion(server('6.2.14'), (m) => warnings.push(m)),
    ).rejects.toThrow(/Redis 6\.2\.14 is too old.*7\.0\.0 or newer/);
    await assertRedisVersion(server('8.10.0'), (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it('warns and goes on when the server does not answer, or names no version', async () => {
    const warnings: string[] = [];
    const silent = {
      info: () => new Promise<string>(() => undefined),
    } as unknown as Pick<Redis, 'info'>;
    await assertRedisVersion(silent, (m) => warnings.push(m), 50);
    await assertRedisVersion(info('# Server\r\n'), (m) => warnings.push(m));
    const failing = {
      info: async () => {
        throw new Error('NOAUTH Authentication required');
      },
    } as unknown as Pick<Redis, 'info'>;
    await assertRedisVersion(failing, (m) => warnings.push(m));
    expect(warnings).toEqual([
      'Redis version not checked: no answer within 50 ms',
      'Redis version not checked: INFO server names none',
      'Redis version not checked: NOAUTH Authentication required',
    ]);
  });
});

const config = (values: Record<string, unknown> = {}) =>
  ({
    get: (key: string) =>
      ({
        REDIS_URL: 'redis://localhost:6379/2',
        REDIS_SENTINELS: [],
        ...values,
      })[key],
  }) as unknown as Config<CoreEnv>;

describe('connection options', () => {
  it('keeps the shared and worker connections waiting for Redis', () => {
    const options = redisOptions(config());
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.enableOfflineQueue).toBeUndefined();
  });

  it('gives the queues (producers) a fail-fast connection to the same Redis', () => {
    const options = producerRedisOptions(config());
    expect(options.enableOfflineQueue).toBe(false);
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options).toMatchObject({ host: 'localhost', port: 6379, db: 2 });
  });
});

describe('a producer connection with Redis unreachable', () => {
  it('rejects at once and sends nothing when Redis returns', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, 'close');

    const client = new Redis({
      ...producerRedisOptions(config()),
      host: '127.0.0.1',
      port,
      retryStrategy: () => 50,
      lazyConnect: false,
    });
    client.on('error', () => undefined);
    const started = Date.now();
    // The add of an abandoned request: not buffered offline.
    await expect(client.set('job', '1')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);

    // Redis comes back: the rejected command must not arrive.
    const received: string[] = [];
    const returned = createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk.toString()));
    });
    returned.listen(port, '127.0.0.1');
    await once(returned, 'listening');
    await new Promise((resolve) => setTimeout(resolve, 400));
    client.disconnect();
    returned.close();
    expect(received.join('')).not.toContain('job');
  });
});

describe('redisWithin', () => {
  it('returns the answer of a ready client', async () => {
    await expect(
      redisWithin({ status: 'ready' }, () => Promise.resolve('1')),
    ).resolves.toBe('1');
  });

  it('fails at once, without calling Redis, when the client is not connected', async () => {
    const read = vi.fn();
    await expect(
      redisWithin({ status: 'reconnecting' }, read),
    ).rejects.toBeInstanceOf(RedisUnavailableError);
    expect(read).not.toHaveBeenCalled();
  });

  it('fails after the timeout when Redis stays silent', async () => {
    const started = Date.now();
    await expect(
      redisWithin({ status: 'ready' }, () => new Promise(() => {}), 100),
    ).rejects.toThrow('took over 100 ms');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
