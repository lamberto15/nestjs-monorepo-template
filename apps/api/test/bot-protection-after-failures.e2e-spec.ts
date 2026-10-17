import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { REDIS } from '../src/core/redis/redis.js';
import { bootApp, newPassword, totp, type TestApp } from './support.js';

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
    // Self sign-up, for an account whose address is unproved.
    AUTH_SIGN_UP: 'on',
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
  /** An account with two-factor on: its address, password and recovery codes. */
  async function withMfa() {
    // Invited and accepted (a proved address), signed in from loopback.
    const { email: target, password, agent } = await node.user([]);
    const { secret } = (await agent.post('/v1/auth/mfa/enroll').expect(200))
      .body as { secret: string };
    const { recoveryCodes } = (
      await agent
        .post('/v1/auth/mfa/confirm')
        .send({ code: totp(secret) })
        .expect(200)
    ).body as { recoveryCodes: string[] };
    return { email: target, password, recoveryCodes };
  }

  /** The failure counter of a tracker (an address, or `email|address`), as CaptchaService keys it. */
  async function failures(tracker: string) {
    const hash = createHash('sha256').update(tracker).digest('base64url');
    const value = await node.app
      .get<Redis>(REDIS)
      .get(`captcha:failures:${hash}`);
    return Number(value ?? 0);
  }

  it("counts a wrong two-factor code at the browser's second step as a failed sign-in, and challenges it there", async () => {
    const account = await withMfa();
    const address = ip();
    const browser = request.agent(node.app.getHttpServer());
    const verify = (body: object, token?: string) => {
      const req = browser
        .post('/v1/auth/mfa/verify')
        .set('X-Forwarded-For', address);
      if (token) {
        req.set('X-Captcha-Token', token);
      }
      return req.send(body);
    };
    // The right password is no failure: given back.
    const first = await browser
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', address)
      .send({ email: account.email, password: account.password })
      .expect(200);
    expect(first.body).toEqual({ signedIn: false, mfaRequired: true });
    expect(await failures(address)).toBe(0);
    // Two wrong codes: counted on the address and on the account's email and
    // address, the keys a wrong password counts on.
    await verify({ code: '000000' }).expect(401);
    await verify({ code: '000001' }).expect(401);
    expect(await failures(address)).toBe(2);
    expect(await failures(`${account.email}|${address}`)).toBe(2);
    // The third attempt wants a token, as a third wrong password would.
    const asked = await verify({ recoveryCode: account.recoveryCodes[0] });
    expect(asked.status).toBe(403);
    expect(asked.body).toMatchObject({
      code: 'captcha_required',
      action: 'sign-in',
    });
    // With one, the right code signs in, and gives its attempt back.
    await verify(
      { recoveryCode: account.recoveryCodes[0] },
      siteverify.token(),
    ).expect(200, { signedIn: true, mfaRequired: false });
    expect(await failures(address)).toBe(3);
    // The password step shares the counters: it asks too.
    const signIn = await browser
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', address)
      .send({ email: account.email, password: account.password });
    expect(signIn.status).toBe(403);
    expect(signIn.body.code).toBe('captcha_required');
  });

  it('counts wrong codes like wrong passwords: the same answers as for an account that does not exist', async () => {
    const account = await withMfa();
    const sequence = async (
      target: string,
      attempt: (address: string) => Promise<request.Response>,
    ) => {
      const address = ip();
      const statuses = [
        (await attempt(address)).status,
        (await attempt(address)).status,
      ];
      // The third is a password sign-in for the same email, from the same address.
      statuses.push((await signIn(address, target)).status);
      return statuses;
    };
    const wrongCodes = await sequence(account.email, (address) =>
      node.http().post('/v1/auth/token').set('X-Forwarded-For', address).send({
        email: account.email,
        password: account.password,
        code: '000000',
      }),
    );
    const nobody = email();
    const wrongPasswords = await sequence(nobody, (address) =>
      signIn(address, nobody),
    );
    expect(wrongCodes).toEqual([401, 401, 403]);
    expect(wrongPasswords).toEqual(wrongCodes);
  });

  it('on the token route: the right password without a code counts nothing; a wrong code counts, and is challenged', async () => {
    const account = await withMfa();
    const address = ip();
    const token = (body: object, captcha?: string) => {
      const req = node
        .http()
        .post('/v1/auth/token')
        .set('X-Forwarded-For', address);
      if (captcha) {
        req.set('X-Captcha-Token', captcha);
      }
      return req.send({
        email: account.email,
        password: account.password,
        ...body,
      });
    };
    // Asked for the second factor: no failure (the browser's sign-in
    // answers it with a 200). Within the route's own limit of 5 requests.
    const asked = await token({}).expect(401);
    expect(JSON.stringify(asked.body)).toContain('mfa_required');
    expect(await failures(address)).toBe(0);
    expect(await failures(`${account.email}|${address}`)).toBe(0);
    // Wrong codes are failures, on both keys.
    await token({ code: '000000' }).expect(401);
    await token({ recoveryCode: 'not-a-recovery-code' }).expect(401);
    expect(await failures(`${account.email}|${address}`)).toBe(2);
    const refused = await token({ recoveryCode: account.recoveryCodes[1] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('captcha_required');
    const issued = await token(
      { recoveryCode: account.recoveryCodes[1] },
      siteverify.token(),
    ).expect(200);
    expect(issued.body.accessToken).toEqual(expect.any(String));
  });

  it('counts the second step without a pending sign-in on the address alone', async () => {
    const address = ip();
    const verify = () =>
      node
        .http()
        .post('/v1/auth/mfa/verify')
        .set('X-Forwarded-For', address)
        .send({ code: '000000' });
    await verify().expect(401);
    await verify().expect(401);
    const asked = await verify().expect(403);
    expect(asked.body.code).toBe('captcha_required');
    expect(await failures(address)).toBe(3);
  });
  it("counts an unproved address's right password (403 email_unverified) as a failure, on both sign-ins: the challenge comes as for a wrong one", async () => {
    const target = email();
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .set('X-Forwarded-For', ip())
      .send({ email: target, name: 'Unproved', password })
      .expect(201);
    for (const route of ['/v1/auth/sign-in', '/v1/auth/token']) {
      const address = ip();
      const attempt = () =>
        node
          .http()
          .post(route)
          .set('X-Forwarded-For', address)
          .send({ email: target, password });
      const first = await attempt().expect(403);
      expect(first.body.code).toBe('email_unverified');
      await attempt().expect(403);
      // Counted like a wrong password: the third wants a token, before the
      // password is looked at, the same problem as for any account.
      const asked = await attempt().expect(403);
      expect(asked.body.code).toBe('captcha_required');
      expect(await failures(`${target}|${address}`)).toBe(3);
      // Someone with no account, on the same route: the same problem.
      const nobody = email();
      const other = ip();
      const wrong = () =>
        node
          .http()
          .post(route)
          .set('X-Forwarded-For', other)
          .send({ email: nobody, password: newPassword() });
      await wrong().expect(401);
      await wrong().expect(401);
      const { requestId: _a, ...forNobody } = (await wrong().expect(403))
        .body as Record<string, unknown>;
      const { requestId: _b, ...forUnproved } = asked.body as Record<
        string,
        unknown
      >;
      expect(forUnproved).toEqual(forNobody);
    }
  });
});
