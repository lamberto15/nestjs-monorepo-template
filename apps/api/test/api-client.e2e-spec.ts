import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { OutboxRelay } from '@nestjs/outbox';
import {
  ApiError,
  createApiClient,
  createRealtime,
  type NotificationItem,
  type Realtime,
  unwrap,
  watchNotifications,
} from '@nestjs-monorepo-template/api-client';
import { bootApp, type TestApp } from './support.js';

/**
 * The typed client (packages/api-client, a workspace dependency: built
 * first, `dependsOn: ["^build"]` in turbo.json) against the running app.
 */
describe('api client (e2e)', () => {
  let node: TestApp;
  let realtime: Realtime | undefined;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    realtime?.close();
    await node.close();
  });

  const baseUrl = () => {
    const { port } = node.app.getHttpServer().address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  it('is generated from the document the app serves', async () => {
    const committed = JSON.parse(
      readFileSync(
        createRequire(import.meta.url).resolve(
          '@nestjs-monorepo-template/api-client/openapi.json',
        ),
        'utf8',
      ),
    );
    const served = (await node.http().get('/api-json').expect(200)).body;
    // Stale: run pnpm client:generate.
    expect(served).toEqual(committed);
  });

  it('writes, pages and hears notifications as an API client', async () => {
    const { key } = await node.client();
    const api = createApiClient({
      baseUrl: baseUrl(),
      credentials: { apiKey: key },
    });
    realtime = createRealtime({ url: baseUrl(), token: key });
    await realtime.connected();
    expect((await realtime.whoami()).kind).toBe('client');
    const heard: NotificationItem[] = [];
    const unread: number[] = [];
    watchNotifications(realtime, {
      onItem: (item) => heard.push(item),
      onUnread: (count) => unread.push(count),
    });

    // A POST gets its Idempotency-Key from the client (the route requires one).
    const note = await unwrap(
      api.POST('/v1/notes', { body: { title: 'Typed', body: 'client' } }),
    );
    await unwrap(
      api.POST('/v1/notes', { body: { title: 'Second', body: '' } }),
    );
    const ids: string[] = [];
    for await (const item of api.items('/v1/notes', { limit: '1' })) {
      ids.push(item.id);
    }
    expect(ids).toHaveLength(2);
    expect(ids).toContain(note.id);

    // Problems are thrown as ApiError, with the stable code.
    const missing = await api
      .GET('/v1/notes/{id}', {
        params: { path: { id: '01990000-0000-7000-8000-000000000000' } },
      })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ApiError);
    expect(missing).toMatchObject({ status: 404, code: 'not_found' });

    // The publication workflow publishes the note; its notification is pushed.
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    await node.app.get(OutboxRelay).runOnce();
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    expect(heard[0]).toMatchObject({ type: 'note.published', read: false });
    await vi.waitFor(() => expect(unread.at(-1)).toBeGreaterThan(0));
    const { unread: count } = await unwrap(
      api.GET('/v1/notifications/unread-count'),
    );
    expect(count).toBe(unread.at(-1));
  });
});
