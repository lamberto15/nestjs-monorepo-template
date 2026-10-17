import { randomUUID } from 'node:crypto';
import { CORS_EXPOSED_HEADERS } from '../src/core/http/http-setup.js';
import { bootApp, type TestApp } from './support.js';

// Read when the app is set up: a browser app on another origin.
await vi.hoisted(async () => {
  Object.assign(process.env, { CORS_ORIGINS: 'https://web.example.com' });
});

const WEB = 'https://web.example.com';

/** What a browser app on CORS_ORIGINS may read of a response (core/http/http-setup.ts). */
describe('CORS (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  it('lets a browser app read ETag and Location, besides the request id', async () => {
    const created = await node
      .admin()
      .post('/v1/test-items')
      .set('Origin', WEB)
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Cross-origin' })
      .expect(201);
    expect(created.headers['access-control-allow-origin']).toBe(WEB);
    const exposed = (created.headers['access-control-expose-headers'] as string)
      .split(',')
      .map((name) => name.trim().toLowerCase());
    expect(exposed).toEqual(
      expect.arrayContaining([
        'x-request-id',
        'retry-after',
        'content-language',
        'etag',
        'location',
        'idempotent-replayed',
      ]),
    );
    expect(exposed).toEqual(
      CORS_EXPOSED_HEADERS.map((name) => name.toLowerCase()),
    );
    // The header it exposes is there to read.
    expect(created.headers.etag).toMatch(/^"[\w-]+"$/);
  });

  it('lets no other origin read the response', async () => {
    const res = await node
      .admin()
      .get('/v1/test-items')
      .set('Origin', 'https://evil.example.com')
      .expect(200);
    // Without Access-Control-Allow-Origin the browser shows it nothing, exposed headers included.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
