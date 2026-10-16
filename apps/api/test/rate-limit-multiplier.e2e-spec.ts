/**
 * RATE_LIMIT_MULTIPLIER (the load test's stack, compose.loadtest.yaml):
 * every limit is raised, none turned off. Sign-in's 5 per 15 minutes
 * becomes 10 here.
 */
import { randomUUID } from 'node:crypto';
import { bootApp, newPassword, type TestApp } from './support.js';

// Read when AppModule loads: before the imports run.
vi.hoisted(() => {
  process.env.RATE_LIMIT_MULTIPLIER = '2';
});

describe('RATE_LIMIT_MULTIPLIER (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(() => node.close());

  it("raises a route's own limit by the multiplier, and still answers 429 past it", async () => {
    const email = `scaled-${randomUUID().slice(0, 8)}@example.com`;
    for (let attempt = 0; attempt < 10; attempt++) {
      await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email, password: newPassword() })
        .expect(401);
    }
    const limited = await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email, password: newPassword() })
      .expect(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
  });
});
