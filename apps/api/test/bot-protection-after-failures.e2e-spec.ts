import { randomInt, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS } from '../src/core/redis/redis.js';
import { bootApp, newPassword, type TestApp } from './support.js';

// CAPTCHA_MODE=after-failures (read once, when AppModule loads): a token is
// wanted once an address, or an email and address, had CAPTCHA_FAILURES
// failed attempts in the window. The helpers' sign-ins are first attempts
// from the loopback address, so they need no token.
const siteverify = await vi.hoisted(async () => {
  const { startSiteverify } = await import('./captcha-stand-in.js');
  const stand = await startSiteverify();
  Object.assign(process.env, {
    CAPTCHA_MODE: 'after-failures',
    CAPTCHA_FAILURES: '2',
  });
  return stand;
});

const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const email = () => `${randomUUID().slice(0, 8)}@example.com`;

describe('bot protection, after failures (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  beforeEach(() => siteverify.reset());
  afterAll(async () => {
    await node.close();
    await siteverify.close();
  });

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

  it('lets a first sign-in through without a token and reports the mode to the page', async () => {
    const methods = await node.http().get('/v1/auth/methods').expect(200);
    expect(methods.body.captcha).toMatchObject({
      provider: 'turnstile',
      mode: 'after-failures',
    });
    await node
      .http()
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', ip())
      .send({
        email: process.env.ADMIN_EMAIL!,
        password: process.env.ADMIN_PASSWORD!,
      })
      .expect(200);
    expect(siteverify.requests).toHaveLength(0);
  });

  it('asks for a token once an account had CAPTCHA_FAILURES failed sign-ins, whether or not it exists', async () => {
    // The same sequence for an account and for an address nobody has.
    const outcomes: { statuses: number[]; body: unknown }[] = [];
    for (const target of [process.env.ADMIN_EMAIL!, email()]) {
      const address = ip();
      const statuses: number[] = [];
      let last: unknown;
      for (let i = 0; i < 3; i++) {
        const res = await signIn(address, target);
        statuses.push(res.status);
        last = res.body;
      }
      outcomes.push({ statuses, body: last });
      // With a token, the attempt goes through (and is still a wrong password).
      await signIn(address, target, siteverify.token()).expect(401);
    }
    expect(outcomes[0].statuses).toEqual([401, 401, 403]);
    expect(outcomes[1].statuses).toEqual(outcomes[0].statuses);
    // The refusals are the same problem, down to the text.
    const { requestId: _a, ...existing } = outcomes[0].body as Record<
      string,
      unknown
    >;
    const { requestId: _b, ...unknown } = outcomes[1].body as Record<
      string,
      unknown
    >;
    expect(unknown).toEqual(existing);
    expect(existing.code).toBe('captcha_required');
    expect(siteverify.requests).toHaveLength(2);
  });

  it('counts per address too, and never across addresses', async () => {
    const address = ip();
    await signIn(address, email()).expect(401);
    await signIn(address, email()).expect(401);
    const refused = await signIn(address, email()).expect(403);
    expect(refused.body.code).toBe('captcha_required');
    // Another address is not affected by this one's failures.
    await signIn(ip(), email()).expect(401);

    // One account from many addresses: each pair (and each address) starts at zero.
    const target = email();
    for (let i = 0; i < 3; i++) {
      await signIn(ip(), target).expect(401);
    }
  });

  it('counts the account in any case or spelling of the email: one key for the pair', async () => {
    // From one address the pair's count never exceeds the address's, so the
    // answers alone can't tell whether two spellings share a key: the
    // counters themselves can. Two spellings of one email from one address
    // leave two keys (the address's, the pair's), not three.
    const redis = node.app.get<Redis>(REDIS);
    const keys = async () =>
      (await redis.keys(`${process.env.REDIS_PREFIX}:captcha:failures:*`))
        .length;
    const address = ip();
    const target = email();
    const before = await keys();
    await signIn(address, target).expect(401);
    expect(await keys()).toBe(before + 2);
    await signIn(address, ` ${target.toUpperCase()} `).expect(401);
    expect(await keys()).toBe(before + 2);
    // And the pair is at the limit: the third attempt asks.
    const asked = await signIn(address, target).expect(403);
    expect(asked.body.code).toBe('captcha_required');
  });

  it('shares the counters with the token sign-in: a bot alternating the two routes trips both, for any account', async () => {
    const outcomes: number[][] = [];
    for (const target of [process.env.ADMIN_EMAIL!, email()]) {
      const address = ip();
      const statuses: number[] = [];
      const token = () =>
        node
          .http()
          .post('/v1/auth/token')
          .set('X-Forwarded-For', address)
          .send({ email: target, password: newPassword() });
      statuses.push((await signIn(address, target)).status);
      statuses.push((await token()).status);
      const refusedToken = await token();
      statuses.push(refusedToken.status);
      expect(refusedToken.body).toMatchObject({
        code: 'captcha_required',
        action: 'sign-in',
      });
      statuses.push((await signIn(address, target)).status);
      // With a token (the web view's), the attempt goes through on both.
      await token().set('X-Captcha-Token', siteverify.token()).expect(401);
      outcomes.push(statuses);
    }
    expect(outcomes[0]).toEqual([401, 401, 403, 403]);
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it('gives a sign-in that succeeds its attempt back, on either route', async () => {
    const address = ip();
    const credentials = {
      email: process.env.ADMIN_EMAIL!,
      password: process.env.ADMIN_PASSWORD!,
    };
    for (let i = 0; i < 4; i++) {
      await node
        .http()
        .post(i % 2 ? '/v1/auth/token' : '/v1/auth/sign-in')
        .set('X-Forwarded-For', address)
        .send(credentials)
        .expect(200);
    }
    // Nothing counted: a first failure from this address is not asked.
    await signIn(address, email()).expect(401);
  });

  it('counts a parallel burst before judging it: at most CAPTCHA_FAILURES pass without a token', async () => {
    const address = ip();
    const burst = await Promise.all(
      Array.from({ length: 8 }, () =>
        node
          .http()
          .post('/v1/auth/password/forgot')
          .set('X-Forwarded-For', address)
          .send({ email: email() }),
      ),
    );
    const statuses = burst.map((res) => res.status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(2);
    expect(statuses.filter((status) => status === 403)).toHaveLength(6);

    // The same for failed sign-ins (reserved up front).
    const other = ip();
    const signIns = await Promise.all(
      Array.from({ length: 8 }, () => signIn(other, email())),
    );
    expect(signIns.filter((res) => res.status === 401)).toHaveLength(2);
    expect(signIns.filter((res) => res.status === 403)).toHaveLength(6);
  });

  it('counts every request on a route that reveals nothing (forgot password)', async () => {
    const address = ip();
    const forgot = (token?: string) => {
      const req = node
        .http()
        .post('/v1/auth/password/forgot')
        .set('X-Forwarded-For', address);
      if (token) {
        req.set('X-Captcha-Token', token);
      }
      return req.send({ email: email() });
    };
    await forgot().expect(202);
    await forgot().expect(202);
    const refused = await forgot().expect(403);
    expect(refused.body).toMatchObject({
      code: 'captcha_required',
      action: 'forgot-password',
    });
    await forgot(siteverify.token('forgot-password')).expect(202);
  });

  it('keeps a refused token counted as an attempt', async () => {
    const address = ip();
    const target = email();
    await signIn(address, target).expect(401);
    await signIn(address, target, `bad:${randomUUID()}`).expect(401);
    // Two attempts (one of them with a refused... no: a token is checked only
    // once required; the second was a plain wrong password). The third asks.
    await signIn(address, target).expect(403);
    // A refused token on a required attempt counts too: still asked after.
    const bad = await signIn(address, target, `bad:${randomUUID()}`).expect(
      403,
    );
    expect(bad.body.code).toBe('captcha_invalid');
    await signIn(address, target).expect(403);
  });
});
