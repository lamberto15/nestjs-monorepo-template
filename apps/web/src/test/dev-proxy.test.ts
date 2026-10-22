import { createServer as createHttp, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { passthrough } from 'msw';
import { http } from 'msw/http';
import { createServer as createVite, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server as msw } from '@/test/server';
import { devProxy } from '../../dev-proxy.ts';

// The real proxy of Vite's dev server in front of a stand-in API, to see what
// a browser at the web app's origin gets for an attachment's thumbnail: a
// redirect to a link on the page's own origin, which the proxy then serves.
const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );

let api: Server;
let apiOrigin: string;
let vite: ViteDevServer;
let origin: string;

beforeAll(async () => {
  api = createHttp((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/v1/attachments/local/')) {
      // The local disk: a signed link on APP_URL, the API's own address.
      response.writeHead(302, {
        location: `${apiOrigin}/files?key=tenants%2Ft%2Fattachments%2Fa.thumb.webp&signature=s`,
      });
      response.end();
    } else if (url.startsWith('/v1/attachments/s3/')) {
      response.writeHead(302, {
        location:
          'https://bucket.s3.eu-west-1.amazonaws.com/a.thumb.webp?X-Amz-Signature=s',
      });
      response.end();
    } else if (url.startsWith('/files?')) {
      response.writeHead(200, { 'content-type': 'image/webp' });
      response.end(`bytes of ${url}`);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  apiOrigin = `http://127.0.0.1:${await listen(api)}`;
  vite = await createVite({
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    // No watcher, no socket: only the proxy is under test.
    server: {
      host: '127.0.0.1',
      port: 0,
      ws: false,
      watch: null,
      proxy: devProxy(apiOrigin),
    },
  });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
});

// The suite's msw fails a request nobody expected; these two servers are real.
beforeEach(() =>
  msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough())),
);

afterAll(async () => {
  await vite.close();
  await new Promise((resolve) => api.close(resolve));
});

describe('the dev proxy', () => {
  it("redirects a thumbnail to a link on the page's own origin", async () => {
    const response = await fetch(
      `${origin}/v1/attachments/local/download?rendition=thumb`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `${origin}/files?key=tenants%2Ft%2Fattachments%2Fa.thumb.webp&signature=s`,
    );
  });

  it('serves the signed link it sent the browser to', async () => {
    const response = await fetch(
      `${origin}/v1/attachments/local/download?rendition=thumb`,
    );
    expect(response.status).toBe(200);
    // Followed through the dev server, not around it.
    expect(new URL(response.url).origin).toBe(origin);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(await response.text()).toBe(
      'bytes of /files?key=tenants%2Ft%2Fattachments%2Fa.thumb.webp&signature=s',
    );
  });

  it("leaves a redirect to the bucket's host alone", async () => {
    const response = await fetch(
      `${origin}/v1/attachments/s3/download?rendition=thumb`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://bucket.s3.eu-west-1.amazonaws.com/a.thumb.webp?X-Amz-Signature=s',
    );
  });
});
