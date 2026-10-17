import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: this file's apps serve /metrics. Without it
// (every other file), /metrics answers 404: test/metrics-off.e2e-spec.ts.
const TOKEN = vi.hoisted(() => {
  const token = 'metrics-token-for-the-e2e-tests';
  process.env.METRICS_TOKEN = token;
  return token;
});

describe('GET /metrics (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  const scrape = () =>
    node.http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`);

  it('refuses a scrape without the token, or with a wrong one', async () => {
    const missing = await node.http().get('/metrics').expect(401);
    expect(missing.body.code).toBe('unauthorized');
    expect(missing.headers['www-authenticate']).toMatch(/^Bearer/);
    await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}x`)
      .expect(401);
    await node.http().get('/metrics').set('Authorization', TOKEN).expect(401);
  });

  it('serves the Prometheus exposition, never cached', async () => {
    const res = await scrape().expect(200);
    expect(res.headers['content-type']).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    // Not rate limited (the limiter's Redis must not stop the scrape).
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.text).toContain('process_cpu_seconds_total');
    // Balanced once every earlier request is done: only this scrape is in flight.
    expect(res.text).toMatch(/^http_requests_in_flight [01]$/m);
    expect(res.text).toMatch(/^db_pool_connections\{state="total"\} \d+$/m);
    expect(res.text).toMatch(/^db_pool_connections\{state="waiting"\} \d+$/m);
    expect(res.text).toMatch(
      /^queue_jobs\{queue="mail",state="waiting"\} \d+$/m,
    );
    expect(res.text).toMatch(/^outbox_undelivered \d+$/m);
    expect(res.text).toMatch(/^outbox_dead_letters \d+$/m);
    expect(res.text).toMatch(/^outbox_lag_seconds \d+(\.\d+)?$/m);
    expect(res.text).toMatch(/^webhook_deliveries\{state="failed"\} \d+$/m);
    expect(res.text).toMatch(/^webhook_delivery_lag_seconds \d+(\.\d+)?$/m);
    expect(res.text).toMatch(/^approvals_open\{status="pending"\} 0$/m);
    expect(res.text).toMatch(
      /^approvals_open\{status="changes_requested"\} 0$/m,
    );
    expect(res.text).toMatch(/^approvals_overdue_seconds 0$/m);
    // The heap alert's denominator (prom-client has no such default).
    expect(res.text).toMatch(/^nodejs_heap_size_limit_bytes \d+$/m);
  });

  it('times requests by route pattern, never by URL', async () => {
    const id = randomUUID();
    const limited = await node.admin().get('/v1/test-items').expect(200);
    expect(limited.headers['x-ratelimit-limit']).toBeDefined();
    await node.admin().get(`/v1/test-items/${id}`).expect(404);
    await node.http().get('/no-such-route').expect(404);
    await node.http().get('/health').expect(200);

    const text = (await scrape().expect(200)).text;
    expect(text).toContain(
      'http_request_duration_seconds_bucket{le="0.005",method="GET",route="GET /v1/test-items",status="200"}',
    );
    expect(text).toMatch(
      /^http_request_duration_seconds_count\{method="GET",route="GET \/v1\/test-items\/\{id\}",status="404"\} 1$/m,
    );
    expect(text).toContain('route="unmatched",status="404"');
    expect(text).not.toContain(id);
    expect(text).not.toContain('no-such-route');
    // Neither the scrape nor the health checks are measured.
    expect(text).not.toMatch(/route="[A-Z]+ \/(metrics|health)/);
  });

  it('is not in the OpenAPI document', async () => {
    // No version prefix: the scrape is not an API route.
    await node
      .http()
      .get('/v1/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(404);
    const document = (await node.http().get('/api-json').expect(200)).body as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(document.paths)).not.toContain('/metrics');
  });
});
