import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: this file's app serves /metrics.
const TOKEN = vi.hoisted(() => {
  const token = 'metrics-token-for-the-e2e-tests';
  process.env.METRICS_TOKEN = token;
  return token;
});

describe('@Deprecated() (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('signals the deprecation in headers, and only on the deprecated route', async () => {
    const old = await node.http().get('/v1/test-deprecated/old').expect(200);
    expect(old.headers.deprecation).toBe('@1767225600');
    expect(old.headers.sunset).toBe('Fri, 01 Jan 2027 00:00:00 GMT');
    expect(old.headers.link).toContain(
      '<https://example.com/docs/deprecations/old>; rel="deprecation"',
    );
    expect(old.headers.link).toContain('rel="successor-version"');

    const current = await node
      .http()
      .get('/v1/test-deprecated/current')
      .expect(200);
    expect(current.headers.deprecation).toBeUndefined();
    expect(current.headers.sunset).toBeUndefined();
  });

  it('marks the operation deprecated in OpenAPI', async () => {
    const document = (await node.http().get('/api-json').expect(200)).body as {
      paths: Record<string, { get?: { deprecated?: boolean } }>;
    };
    expect(document.paths['/v1/test-deprecated/old']?.get?.deprecated).toBe(
      true,
    );
    expect(
      document.paths['/v1/test-deprecated/current']?.get?.deprecated,
    ).toBeUndefined();
  });

  it('counts the calls by route pattern', async () => {
    await node.http().get('/v1/test-deprecated/old').expect(200);
    await node.http().get('/v1/test-deprecated/current').expect(200);
    const text = (
      await node
        .http()
        .get('/metrics')
        .set('Authorization', `Bearer ${TOKEN}`)
        .expect(200)
    ).text;
    expect(text).toMatch(
      /^deprecated_route_calls_total\{route="GET \/v1\/test-deprecated\/old"\} [2-9]\d*$/m,
    );
    expect(text).not.toContain('route="GET /v1/test-deprecated/current"} ');
  });
});
