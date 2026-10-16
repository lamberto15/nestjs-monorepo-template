import { bootApp, type TestApp } from './support.js';

/** METRICS_TOKEN unset (the default): /metrics is off. The rest: metrics.e2e-spec.ts. */
describe('GET /metrics without METRICS_TOKEN (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('answers 404, with or without a bearer', async () => {
    const res = await node.http().get('/metrics').expect(404);
    expect(res.body.code).toBe('not_found');
    await node
      .http()
      .get('/metrics')
      .set('Authorization', 'Bearer anything-at-all-long-enough')
      .expect(404);
  });
});
