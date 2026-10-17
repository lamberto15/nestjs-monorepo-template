import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import {
  createApiClient,
  createRealtime,
  type NotificationItem,
  type Realtime,
  unwrap,
  watchNotifications,
} from '@nestjs-monorepo-template/api-client';
import { AppModule } from '../src/app.module.js';
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
    // The app as shipped, without the test-only records: the generator's view.
    const shipped = await bootApp(undefined, undefined, { module: AppModule });
    const served = (await shipped.http().get('/api-json').expect(200)).body;
    await shipped.close();
    // Stale: run pnpm client:generate.
    expect(served).toEqual(committed);
  });

  it('connects to realtime as an API client and reads its notifications', async () => {
    const { key } = await node.client();
    const api = createApiClient({
      baseUrl: baseUrl(),
      credentials: { apiKey: key },
    });
    realtime = createRealtime({ url: baseUrl(), token: key });
    await realtime.connected();
    expect((await realtime.whoami()).kind).toBe('client');
    const heard: NotificationItem[] = [];
    watchNotifications(realtime, {
      onItem: (item) => heard.push(item),
      onUnread: () => undefined,
    });

    const { unread } = await unwrap(api.GET('/v1/notifications/unread-count'));
    expect(unread).toBe(0);
    expect(heard).toEqual([]);
  });
});
