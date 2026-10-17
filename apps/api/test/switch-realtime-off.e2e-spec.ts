import type { AddressInfo } from 'node:net';
import { io } from 'socket.io-client';
import { NoRealtime } from '../src/platform/realtime/no-realtime.js';
import { Realtime } from '../src/platform/realtime/realtime.service.js';
import { bootApp, type TestApp } from './support.js';

vi.hoisted(() => {
  process.env.REALTIME = 'off';
});

/** REALTIME=off: no gateway; pushes do nothing; notifications are still stored. */
describe('REALTIME=off (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('has no /realtime namespace', async () => {
    const { port } = node.app.getHttpServer().address() as AddressInfo;
    const socket = io(`http://127.0.0.1:${port}/realtime`, {
      transports: ['websocket'],
      reconnection: false,
    });
    const outcome = await new Promise<string>((resolve) => {
      socket.once('connect', () => resolve('connected'));
      socket.once('connect_error', () => resolve('refused'));
    });
    socket.disconnect();
    expect(outcome).toBe('refused');
  });

  it('gives the features a Realtime whose pushes do nothing', () => {
    const realtime = node.app.get(Realtime);
    expect(realtime).toBeInstanceOf(NoRealtime);
    expect(() => realtime.toRoom('room', 'event', {})).not.toThrow();
  });

  it('still lists notifications', async () => {
    await node.admin().get('/v1/notifications').expect(200);
  });
});
