import { randomInt, randomUUID } from 'node:crypto';
import { bootApp, newPassword, type TestApp, testHooks } from './support.js';

// CAPTCHA_MODE=always with the provider failing: fail-open
// (CAPTCHA_ON_ERROR=allow, the default) is not "unprotected": a strict tier
// (CAPTCHA_DEGRADED_LIMIT per address and per email and address), a metric,
// the replay set. Each test boots an app: the circuit breaker is per process.
const siteverify = await vi.hoisted(async () => {
  const { startSiteverify } = await import('./captcha-stand-in.js');
  const { randomBytes } = await import('node:crypto');
  const stand = await startSiteverify();
  Object.assign(process.env, {
    CAPTCHA_MODE: 'always',
    CAPTCHA_ON_ERROR: 'allow',
    CAPTCHA_DEGRADED_LIMIT: '2',
    // So /metrics answers here (made up per run).
    METRICS_TOKEN: randomBytes(12).toString('hex'),
  });
  return stand;
});

const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const email = () => `${randomUUID().slice(0, 8)}@example.com`;

describe('bot protection, the provider is down (fail-open, e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    siteverify.reset();
    testHooks.captchaToken = () => siteverify.token();
    node = await bootApp();
    siteverify.requests.length = 0;
  });
  afterEach(async () => {
    delete testHooks.captchaToken;
    await node.close();
  });
  afterAll(() => siteverify.close());

  function signIn(address: string, target: string, token?: string) {
    const req = node
      .http()
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', address);
    if (token) {
      req.set('X-Captcha-Token', token);
    }
    return req.send({ email: target, password: newPassword() });
  }

  it('lets CAPTCHA_DEGRADED_LIMIT requests through unverified per address, then 429; counts it', async () => {
    siteverify.state.down = true;
    const address = ip();
    const target = email();
    await signIn(address, target, siteverify.token()).expect(401);
    await signIn(address, target, siteverify.token()).expect(401);
    const refused = await signIn(address, target, siteverify.token());
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // The provider was asked each time: the breaker needs 5 calls to open.
    expect(siteverify.requests).toHaveLength(3);
    // The same account from another address: that pair, and that address, start at zero.
    await signIn(ip(), target, siteverify.token()).expect(401);

    const metrics = await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`)
      .expect(200);
    expect(metrics.text).toMatch(
      /^captcha_verifications_total\{outcome="unavailable"\} 4$/m,
    );
  });

  it("treats siteverify refusing our secret as an outage, not as the user's invalid token", async () => {
    // A 200 with success:false and invalid-input-secret: a mis-rotated key
    // must not lock everyone out with a 403; fail-open serves and counts it.
    await signIn(ip(), email(), `secret:sign-in:${randomUUID()}`).expect(401);
    const metrics = await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`)
      .expect(200);
    expect(metrics.text).toMatch(
      /^captcha_verifications_total\{outcome="unavailable"\} 1$/m,
    );
    expect(metrics.text).toMatch(
      /^captcha_verifications_total\{outcome="rejected"\} 0$/m,
    );
  });

  it('gives a verification that hangs up after CAPTCHA_TIMEOUT_MS, then serves the request', async () => {
    siteverify.state.hang = true;
    const started = Date.now();
    await signIn(ip(), email(), siteverify.token()).expect(401);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });

  it('once the breaker is open, serves a request without a token under the same limit, without asking', async () => {
    siteverify.state.down = true;
    // Five calls (minimumCalls), half of them failed, open the breaker: the
    // helper's sign-in at boot was the first (a success), so the fourth
    // failure opens it and the fifth attempt is no longer asked.
    for (let i = 0; i < 5; i++) {
      await signIn(ip(), email(), siteverify.token()).expect(401);
    }
    const asked = siteverify.requests.length;
    expect(asked).toBe(4);
    // The widget can't mint a token while the provider is down: no token, still served.
    const address = ip();
    await signIn(address, email()).expect(401);
    await signIn(address, email()).expect(401);
    const refused = await signIn(address, email()).expect(429);
    expect(refused.body.code).toBe('rate_limited');
    // Nor is a token verified while the breaker is open.
    await signIn(ip(), email(), siteverify.token()).expect(401);
    expect(siteverify.requests).toHaveLength(asked);
  });
});
