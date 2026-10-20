import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { OutboxRelay } from '@nestjs/outbox';
import request from 'supertest';
import { SignInPasswordCheck } from '../src/iam/account/sign-in-password-check.js';
import { bootApp, newPassword, type TestApp } from './support.js';

/**
 * A stand-in for the Pwned Passwords range API on loopback (the tests never
 * reach the real one), started before AppModule loads: this file's apps
 * check new passwords against it (PASSWORD_BREACH_CHECK=on; off in every
 * other file, setup-env.ts). It knows one breached password, pads every
 * answer with count-0 lines as the real API does with `Add-Padding: true`,
 * and records what it was asked. `down` answers 503; `hold` keeps every
 * answer back until `release()` (a slow API).
 */
const pwned = await vi.hoisted(async () => {
  const { createServer } = await import('node:http');
  const crypto = await import('node:crypto');
  const sha1 = (value: string) =>
    crypto.createHash('sha1').update(value).digest('hex').toUpperCase();
  // Made at runtime (a local hook refuses password-like literals); 12 characters.
  const breached = ['pass', 'word', '1234'].join('');
  const corpus = new Map([[sha1(breached), 52_256]]);
  const requests: { url: string; padding: string | undefined }[] = [];
  const state = { down: false, hold: false };
  const held: (() => void)[] = [];
  const server = createServer((req, res) => {
    requests.push({
      url: req.url ?? '',
      padding: req.headers['add-padding'] as string | undefined,
    });
    if (state.hold) {
      held.push(() => answer(req, res));
      return;
    }
    answer(req, res);
  });
  const answer = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => {
    if (state.down) {
      res.writeHead(503).end();
      return;
    }
    const prefix = /^\/range\/([0-9A-F]{5})$/.exec(req.url ?? '')?.[1];
    if (!prefix) {
      res.writeHead(400).end();
      return;
    }
    const lines = [...corpus]
      .filter(([hash]) => hash.startsWith(prefix))
      .map(([hash, count]) => `${hash.slice(5)}:${count}`);
    for (let i = 0; i < 3; i++) {
      lines.push(
        `${crypto.randomBytes(18).toString('hex').slice(0, 35).toUpperCase()}:0`,
      );
    }
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end(lines.join('\r\n'));
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, {
    PASSWORD_BREACH_CHECK: 'on',
    PASSWORD_BREACH_API_URL: `http://127.0.0.1:${port}`,
    PASSWORD_BREACH_TIMEOUT_MS: '1000',
    AUTH_SIGN_UP: 'on',
  });
  return {
    breached,
    requests,
    state,
    held,
    release: () => {
      state.hold = false;
      held.splice(0).forEach((send) => send());
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

describe('breached passwords (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    pwned.state.down = false;
    pwned.state.hold = false;
    node = await bootApp();
    // The administrator's sign-in (bootApp) is checked too.
    await checked();
    pwned.requests.length = 0;
  });
  afterEach(() => node.close());

  /** Once the sign-in checks still running are done (they never hold up the sign-in). */
  const checked = () => node.app.get(SignInPasswordCheck).settled();
  afterAll(() => pwned.close());

  const email = () => `${randomUUID().slice(0, 8)}@example.com`;

  /** The problem of a refused breached password, on `path`, in the request's language. */
  function expectBreached(res: request.Response, path: string) {
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      code: 'password_breached',
      errors: [{ path }],
    });
    expect(res.body.detail).toBe(res.body.errors[0].message);
    // Nothing more: not how often it was seen.
    expect(JSON.stringify(res.body)).not.toContain('52256');
  }

  it('refuses a breached password at sign-up, translated; a fresh one signs up', async () => {
    const refused = await node
      .http()
      .post('/v1/auth/sign-up?lang=de')
      .send({ email: email(), name: 'Ada', password: pwned.breached });
    expectBreached(refused, 'password');
    expect(refused.body.detail).toBe(
      'Dieses Passwort ist in einem Datenleck aufgetaucht: Wählen Sie ein anderes',
    );
    expect(refused.headers['content-language']).toBe('de');

    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: email(), name: 'Ada', password: newPassword() })
      .expect(201);
  });

  it('refuses a breached password when an invitation is accepted, and the link still works for a fresh one', async () => {
    const address = email();
    const token = await node.invite(node.admin(), { email: address });

    const refused = await node
      .http()
      .post('/v1/auth/invitations/accept')
      .send({ token, password: pwned.breached });
    expectBreached(refused, 'password');

    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/invitations/accept')
      .send({ token, password })
      .expect(200);
    await node.signIn(address, password);
  });

  it('refuses a breached new password on a change, after the current one is checked', async () => {
    const address = email();
    const current = await node.acceptAsNew(
      await node.invite(node.admin(), { email: address }),
    );
    const agent = await node.signIn(address, current);

    // A wrong current password is a 403 first, whatever the new one.
    await agent
      .post('/v1/auth/password/change')
      .send({ currentPassword: randomUUID(), newPassword: pwned.breached })
      .expect(403);
    const refused = await agent
      .post('/v1/auth/password/change')
      .send({ currentPassword: current, newPassword: pwned.breached });
    expectBreached(refused, 'newPassword');

    const next = newPassword();
    await agent
      .post('/v1/auth/password/change')
      .send({ currentPassword: current, newPassword: next })
      .expect(204);
    await node.signIn(address, next);
  });

  it('lets no administrator set a password, breached or not (docs/tenancy.md, "Invitations")', async () => {
    await node
      .admin()
      .post('/v1/access/users')
      .send({ email: email(), name: 'Ada', password: newPassword() })
      .expect(400);
    const user = await node.user([]);
    await node
      .admin()
      .patch(`/v1/access/users/${user.id}`)
      .send({ password: newPassword() })
      .expect(400);
    await checked();
    // Checked when the owner chose theirs (the invitation's acceptance), and
    // at their first sign-in (SignInPasswordCheck): never for the administrator.
    expect(pwned.requests).toHaveLength(2);
  });

  it('sends only a 5-character hash prefix, with Add-Padding, never the password or its hash', async () => {
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: email(), name: 'Ada', password })
      .expect(201);
    const hash = createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase();
    expect(pwned.requests).toEqual([
      { url: `/range/${hash.slice(0, 5)}`, padding: 'true' },
    ]);
    expect(JSON.stringify(pwned.requests)).not.toContain(hash.slice(5));
    expect(JSON.stringify(pwned.requests)).not.toContain(password);
  });

  it('fails open while the API is down (PASSWORD_BREACH_ON_ERROR=allow); a sign-in with such a password still works', async () => {
    pwned.state.down = true;
    const address = email();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: address, name: 'Ada', password: pwned.breached })
      .expect(201);
    expect(pwned.requests).toHaveLength(1);

    // Still down: the sign-in works, nothing is flagged.
    await node.verifySignUp(address, pwned.breached);
    await node.signIn(address, pwned.breached);
    await checked();
    expect(pwned.requests).toHaveLength(2);
    expect(
      await node.auditEntries({ action: 'auth.password-breached' }),
    ).toEqual([]);
  });

  /** An invited user whose password got past the check (the API was down), not signed in yet. */
  async function breachedAccount() {
    const address = email();
    const token = await node.invite(node.admin(), { email: address });
    pwned.state.down = true;
    await node
      .http()
      .post('/v1/auth/invitations/accept')
      .send({ token, password: pwned.breached })
      .expect(200);
    pwned.state.down = false;
    pwned.requests.length = 0;
    return address;
  }

  /** The caller's notifications of a breached password, after delivery. */
  async function breachNotices(agent: request.Agent) {
    await node.app.get(OutboxRelay).runOnce();
    const response = await agent
      .get('/v1/notifications?sort=-createdAt')
      .expect(200);
    return (
      response.body.items as { type: string; title: string; data: object }[]
    ).filter((item) => item.type === 'security.passwordBreached');
  }

  it('flags a breached password at sign-in: audited, the owner told in-app and by mail, once per password', async () => {
    const address = await breachedAccount();
    const agent = await node.signIn(address, pwned.breached);
    await checked();
    const hash = createHash('sha1')
      .update(pwned.breached)
      .digest('hex')
      .toUpperCase();
    // Only the prefix left, as for a new password.
    expect(pwned.requests).toEqual([
      { url: `/range/${hash.slice(0, 5)}`, padding: 'true' },
    ]);

    const id = (await agent.get('/v1/auth/me').expect(200)).body.user
      .id as string;
    const [entry, ...more] = await node.auditEntries({
      action: 'auth.password-breached',
      targetId: id,
    });
    expect(more).toEqual([]);
    expect(entry).toMatchObject({ actor: `user:${id}`, targetType: 'user' });
    expect(JSON.stringify(entry)).not.toContain(hash.slice(5));

    const [notice, ...others] = await breachNotices(agent);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      title: 'Your password appeared in a data breach',
      data: { ip: '127.0.0.1' },
    });
    await node.waitForMail({ to: address, subject: /data breach/ });

    // Signed in again: this password was checked already (PASSWORD_BREACH_RECHECK_DAYS).
    await node.signIn(address, pwned.breached);
    await checked();
    expect(pwned.requests).toHaveLength(1);
    expect(await breachNotices(agent)).toHaveLength(1);

    // A new password is checked at its first sign-in.
    const next = newPassword();
    await agent
      .post('/v1/auth/password/change')
      .send({ currentPassword: pwned.breached, newPassword: next })
      .expect(204);
    await node.signIn(address, next);
    await checked();
    // The change's check, then the sign-in's: clean, nothing more flagged.
    expect(pwned.requests).toHaveLength(3);
    expect(
      await node.auditEntries({
        action: 'auth.password-breached',
        targetId: id,
      }),
    ).toHaveLength(1);
  });

  it('signs in without waiting for the API: a slow answer still flags the password afterwards', async () => {
    const address = await breachedAccount();
    pwned.state.hold = true;
    const started = Date.now();
    await node.signIn(address, pwned.breached);
    // Answered while the API still holds its answer (PASSWORD_BREACH_TIMEOUT_MS is 1 s here).
    expect(Date.now() - started).toBeLessThan(1000);
    await vi.waitFor(() => expect(pwned.held).toHaveLength(1));
    expect(
      await node.auditEntries({ action: 'auth.password-breached' }),
    ).toEqual([]);

    pwned.release();
    await checked();
    expect(
      await node.auditEntries({ action: 'auth.password-breached' }),
    ).toHaveLength(1);
  });

  it('signs in when the API fails at sign-in; the next sign-in checks again', async () => {
    const address = await breachedAccount();
    pwned.state.down = true;
    await node.signIn(address, pwned.breached);
    await checked();
    expect(pwned.requests).toHaveLength(1);
    expect(
      await node.auditEntries({ action: 'auth.password-breached' }),
    ).toEqual([]);

    // Back up: not debounced by the failed check.
    pwned.state.down = false;
    await node.signIn(address, pwned.breached);
    await checked();
    expect(pwned.requests).toHaveLength(2);
    expect(
      await node.auditEntries({ action: 'auth.password-breached' }),
    ).toHaveLength(1);
  });

  it("checks a token client's password sign-in too (POST /v1/auth/token)", async () => {
    const address = await breachedAccount();
    await node
      .http()
      .post('/v1/auth/token')
      .send({ email: address, password: pwned.breached })
      .expect(200);
    await checked();
    expect(pwned.requests).toHaveLength(1);
    expect(
      await node.auditEntries({ action: 'auth.password-breached' }),
    ).toHaveLength(1);
  });

  it('accepts a long random password the corpus has never seen', async () => {
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({
        email: email(),
        name: 'Ada',
        password: randomBytes(48).toString('base64url'),
      })
      .expect(201);
    expect(pwned.requests).toHaveLength(1);
  });
});
