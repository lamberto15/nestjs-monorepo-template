import { randomInt, randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootApp, newPassword, type TestApp, testHooks } from './support.js';

// Read when AppModule loads (ConfigModule validates the environment once per
// file): CAPTCHA_MODE=always against the siteverify stand-in. The other
// modes have files of their own; every other file runs with the mode off.
const siteverify = await vi.hoisted(async () => {
  const { startSiteverify } = await import('./captcha-stand-in.js');
  const stand = await startSiteverify();
  const { randomBytes } = await import('node:crypto');
  Object.assign(process.env, {
    CAPTCHA_MODE: 'always',
    CAPTCHA_ON_ERROR: 'allow',
    AUTH_SIGN_UP: 'on',
    // So /metrics answers here (made up per run).
    METRICS_TOKEN: randomBytes(12).toString('hex'),
  });
  return stand;
});

/** An address of its own (trusted proxy: X-Forwarded-For), so limits don't add up across tests. */
const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const email = () => `${randomUUID().slice(0, 8)}@example.com`;

describe('bot protection, always (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    testHooks.captchaToken = () => siteverify.token();
    node = await bootApp();
  });
  beforeEach(() => siteverify.reset());
  afterAll(async () => {
    delete testHooks.captchaToken;
    await node.close();
    await siteverify.close();
  });

  /** A sign-in attempt from `address`, with a token when given. */
  function signIn(
    address: string,
    body: { email: string; password?: string },
    token?: string,
  ) {
    const req = node
      .http()
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', address);
    if (token) {
      req.set('X-Captcha-Token', token);
    }
    return req.send({ password: newPassword(), ...body });
  }

  const expectProblem = (
    res: request.Response,
    status: number,
    code: string,
  ) => {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe(code);
  };

  it('tells the sign-in page the provider, the site key and the mode', async () => {
    const methods = await node.http().get('/v1/auth/methods').expect(200);
    expect(methods.body.captcha).toEqual({
      provider: 'turnstile',
      siteKey: siteverify.siteKey,
      mode: 'always',
    });
  });

  it('refuses a sign-in without a token: 403 captcha_required naming the widget, translated', async () => {
    const res = await signIn(ip(), { email: process.env.ADMIN_EMAIL! });
    expectProblem(res, 403, 'captcha_required');
    expect(res.body).toMatchObject({
      provider: 'turnstile',
      siteKey: siteverify.siteKey,
      action: 'sign-in',
    });
    expect(JSON.stringify(res.body)).not.toContain(siteverify.secretKey);
    expect(siteverify.requests).toHaveLength(0);

    const de = await node
      .http()
      .post('/v1/auth/sign-in?lang=de')
      .send({ email: process.env.ADMIN_EMAIL!, password: newPassword() });
    expectProblem(de, 403, 'captcha_required');
    expect(de.body.detail).toBe(
      'Bestätigen Sie, dass Sie kein Roboter sind: Lösen Sie die Aufgabe und versuchen Sie es erneut',
    );
    expect(de.headers['content-language']).toBe('de');
  });

  it('verifies the token server-side (secret, token, address) and lets the sign-in through', async () => {
    const address = ip();
    await signIn(
      address,
      {
        email: process.env.ADMIN_EMAIL!,
        password: process.env.ADMIN_PASSWORD!,
      },
      siteverify.token(),
    ).expect(200);
    expect(siteverify.requests).toHaveLength(1);
    expect(siteverify.requests[0]).toMatchObject({
      url: '/siteverify',
      secret: siteverify.secretKey,
      remoteip: address,
    });
    expect(Object.keys(siteverify.requests[0]).sort()).toEqual([
      'remoteip',
      'response',
      'secret',
      'url',
    ]);
    // A valid token doesn't make a wrong password right: still a 401.
    await signIn(
      ip(),
      { email: process.env.ADMIN_EMAIL! },
      siteverify.token(),
    ).expect(401);
  });

  it('refuses an invalid token, one the provider saw before, another action and another host', async () => {
    const invalid = await signIn(
      ip(),
      { email: email() },
      `bad:${randomUUID()}`,
    );
    expectProblem(invalid, 403, 'captcha_invalid');
    expect(invalid.body).toMatchObject({
      reason: 'invalid',
      action: 'sign-in',
      siteKey: siteverify.siteKey,
    });

    const spent = await signIn(
      ip(),
      { email: email() },
      `spent:${randomUUID()}`,
    );
    expectProblem(spent, 403, 'captcha_invalid');
    expect(spent.body.reason).toBe('duplicate');

    // Minted on the sign-up page: not good for signing in.
    const other = await signIn(
      ip(),
      { email: email() },
      siteverify.token('sign-up'),
    );
    expectProblem(other, 403, 'captcha_invalid');
    expect(other.body.reason).toBe('action');

    siteverify.state.hostname = 'evil.example';
    const elsewhere = await signIn(
      ip(),
      { email: email() },
      siteverify.token(),
    );
    expectProblem(elsewhere, 403, 'captcha_invalid');
    expect(elsewhere.body.reason).toBe('hostname');
  });

  it('refuses a replayed token here, without asking the provider again', async () => {
    const token = siteverify.token();
    await signIn(ip(), { email: email() }, token).expect(401);
    expect(siteverify.requests).toHaveLength(1);
    // Even from another address and for another account.
    const replay = await signIn(ip(), { email: email() }, token);
    expectProblem(replay, 403, 'captcha_invalid');
    expect(replay.body.reason).toBe('duplicate');
    expect(siteverify.requests).toHaveLength(1);
    // A token longer than any provider's is refused without asking either.
    const huge = await signIn(ip(), { email: email() }, 'x'.repeat(3000));
    expectProblem(huge, 403, 'captcha_invalid');
    expect(huge.body.reason).toBe('invalid');
    expect(siteverify.requests).toHaveLength(1);
  });

  it('guards sign-up, the magic-link request, forgot password and the verification resend too, each with its action', async () => {
    const routes: [string, string, Record<string, unknown>][] = [
      [
        '/v1/auth/sign-up',
        'sign-up',
        { email: email(), name: 'Ada', password: newPassword() },
      ],
      ['/v1/auth/magic-link', 'magic-link', { email: email() }],
      ['/v1/auth/password/forgot', 'forgot-password', { email: email() }],
      [
        '/v1/auth/email/verification/resend',
        'resend-verification',
        { email: email() },
      ],
    ];
    for (const [path, action, body] of routes) {
      const refused = await node
        .http()
        .post(path)
        .set('X-Forwarded-For', ip())
        .send(body);
      expectProblem(refused, 403, 'captcha_required');
      expect(refused.body.action).toBe(action);
      const allowed = await node
        .http()
        .post(path)
        .set('X-Forwarded-For', ip())
        .set('X-Captcha-Token', siteverify.token(action))
        .send(body);
      expect([201, 202], path).toContain(allowed.status);
    }
  });

  it("guards the token sign-in of native apps like the browser's (a web view renders the widget)", async () => {
    const credentials = {
      email: process.env.ADMIN_EMAIL!,
      password: process.env.ADMIN_PASSWORD!,
    };
    const refused = await node
      .http()
      .post('/v1/auth/token')
      .set('X-Forwarded-For', ip())
      .send(credentials);
    expectProblem(refused, 403, 'captcha_required');
    expect(refused.body.action).toBe('sign-in');
    expect(siteverify.requests).toHaveLength(0);
    const issued = await node
      .http()
      .post('/v1/auth/token')
      .set('X-Forwarded-For', ip())
      .set('X-Captcha-Token', siteverify.token())
      .send(credentials)
      .expect(200);
    expect(issued.body.accessToken).toBeDefined();
    expect(siteverify.requests).toHaveLength(1);
  });

  it('is documented as a header on the guarded routes, so the bodies stay as they were', async () => {
    const doc = await node.http().get('/api-json').expect(200);
    for (const path of [
      '/v1/auth/sign-in',
      '/v1/auth/token',
      '/v1/auth/sign-up',
      '/v1/auth/magic-link',
      '/v1/auth/password/forgot',
    ]) {
      const parameters = doc.body.paths[path].post.parameters as {
        name: string;
        in: string;
        required?: boolean;
      }[];
      const header = parameters.find((p) => p.name === 'X-Captcha-Token');
      expect(header, path).toMatchObject({ in: 'header', required: false });
    }
    expect(
      doc.body.paths['/v1/auth/token/refresh'].post.parameters ?? [],
    ).toEqual([]);
  });

  it('counts what it verified, for the alert', async () => {
    const metrics = await node
      .http()
      .get('/metrics')
      .set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`)
      .expect(200);
    expect(metrics.text).toMatch(
      /^captcha_verifications_total\{outcome="passed"\} [1-9]\d*$/m,
    );
    expect(metrics.text).toMatch(
      /^captcha_verifications_total\{outcome="unavailable"\} 0$/m,
    );
  });
});
