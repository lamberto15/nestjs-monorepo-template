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
import { bootApp, type TestApp } from '../../support.js';

/**
 * The typed client (packages/api-client) against the notes routes it is
 * generated for.
 */
describe('api client: notes (e2e)', () => {
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
    // The count follows a delivery within a second (it is coalesced).
    await vi.waitFor(() => expect(unread.at(-1)).toBeGreaterThan(0), {
      timeout: 5000,
    });
    const { unread: count } = await unwrap(
      api.GET('/v1/notifications/unread-count'),
    );
    expect(count).toBe(unread.at(-1));
  });
});
