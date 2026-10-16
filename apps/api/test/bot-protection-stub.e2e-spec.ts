import { randomInt, randomUUID } from 'node:crypto';
import { STUB_TOKENS } from '../src/iam/captcha/stub.verifier.js';
import { bootApp, newPassword, type TestApp, testHooks } from './support.js';

// The stub verifier (no provider), as a load test runs it (docs/auth.md,
// "Bot protection": the load-test hook), and fail-closed
// (CAPTCHA_ON_ERROR=reject): an outage refuses the request with a 503.
vi.hoisted(() => {
  Object.assign(process.env, {
    CAPTCHA_MODE: 'always',
    CAPTCHA_PROVIDER: 'stub',
    CAPTCHA_TIMEOUT_MS: '200',
    CAPTCHA_ON_ERROR: 'reject',
  });
});

const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const fresh = () => `${STUB_TOKENS.pass}:${randomUUID()}`;

describe('bot protection with the stub verifier, fail-closed (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    testHooks.captchaToken = fresh;
    node = await bootApp();
  });
  afterAll(async () => {
    delete testHooks.captchaToken;
    await node.close();
  });

  const signIn = (token?: string) => {
    const req = node
      .http()
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', ip());
    if (token) {
      req.set('X-Captcha-Token', token);
    }
    return req.send({
      email: `${randomUUID().slice(0, 8)}@example.com`,
      password: newPassword(),
    });
  };

  it('tells the page the stub is in place, without a site key', async () => {
    const methods = await node.http().get('/v1/auth/methods').expect(200);
    expect(methods.body.captcha).toEqual({
      provider: 'stub',
      siteKey: null,
      mode: 'always',
    });
  });

  it('judges by the token: pass, fail, spent, another host or action, missing', async () => {
    await signIn(fresh()).expect(401);
    for (const [token, reason] of [
      [STUB_TOKENS.fail, 'invalid'],
      [STUB_TOKENS.spent, 'duplicate'],
      [STUB_TOKENS.elsewhere, 'hostname'],
      [STUB_TOKENS.otherAction, 'action'],
      [`nonsense-${randomUUID()}`, 'invalid'],
    ]) {
      const res = await signIn(token).expect(403);
      expect(res.body).toMatchObject({ code: 'captcha_invalid', reason });
    }
    const missing = await signIn().expect(403);
    expect(missing.body).toMatchObject({
      code: 'captcha_required',
      provider: 'stub',
      siteKey: null,
    });
  });

  it('refuses the same token twice (the replay set): a load test sends a fresh suffix each time', async () => {
    await signIn(STUB_TOKENS.pass).expect(401);
    const again = await signIn(STUB_TOKENS.pass).expect(403);
    expect(again.body.reason).toBe('duplicate');
    await signIn(fresh()).expect(401);
    await signIn(fresh()).expect(401);
  });

  it('fail-closed: an outage or a timeout refuses the request with 503 captcha_unavailable', async () => {
    const down = await signIn(STUB_TOKENS.down).expect(503);
    expect(down.body.code).toBe('captcha_unavailable');
    expect(down.headers['retry-after']).toBe('30');
    expect(down.headers['content-type']).toMatch(/application\/problem\+json/);

    const started = Date.now();
    const slow = await signIn(STUB_TOKENS.slow).expect(503);
    expect(slow.body.code).toBe('captcha_unavailable');
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2000);

    // Nothing to do with the token: without one it is still captcha_required.
    const missing = await signIn().expect(403);
    expect(missing.body.code).toBe('captcha_required');
  });

  it('does not spend a token the provider never judged: the retry a 503 suggests can present it again', async () => {
    const token = `${STUB_TOKENS.down}:${randomUUID()}`;
    await signIn(token).expect(503);
    const again = await signIn(token).expect(503);
    expect(again.body.code).toBe('captcha_unavailable'); // not captcha_invalid duplicate
    const hung = `${STUB_TOKENS.slow}:${randomUUID()}`;
    await signIn(hung).expect(503);
    expect((await signIn(hung).expect(503)).body.code).toBe(
      'captcha_unavailable',
    );
  });
});
