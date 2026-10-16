import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { once } from 'node:events';
import { Redis } from 'ioredis';
import { closeRedis, redisResponds } from './redis.js';

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
