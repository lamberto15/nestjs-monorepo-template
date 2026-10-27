import { randomUUID } from 'node:crypto';
import { TEST_ITEM } from './fixtures/test-items/test-item.record.js';
import { fieldSamples } from '../src/platform/fields/fields.js';
import { bootApp, type TestApp } from './support.js';

/** gzip, applied in Nest (core/http/http-setup.ts), without disturbing ETag. */
describe('response compression (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  it('gzips a response past the threshold, leaves its ETag untouched, and still 304s a conditional read', async () => {
    const admin = node.admin();
    const body = {
      ...fieldSamples(TEST_ITEM.fields).body(),
      body: 'x'.repeat(4096),
    };
    const created = await admin
      .post('/v1/test-items')
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    const id = created.body.id as string;

    const got = await admin
      .get(`/v1/test-items/${id}`)
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(got.headers['content-encoding']).toBe('gzip');
    const etag = got.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]+"$/);

    await admin
      .get(`/v1/test-items/${id}`)
      .set('Accept-Encoding', 'gzip')
      .set('If-None-Match', etag)
      .expect(304);
  });

  it('skips a tiny response: no Content-Encoding below the threshold', async () => {
    const res = await node
      .admin()
      .get('/health')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
