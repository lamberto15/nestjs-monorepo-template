import type request from 'supertest';
import { bootApp, newPassword, type TestApp } from './support.js';

// Many changes from one address in one file: the password routes' limits
// (5 per 15 minutes) are raised, as the load test's stack does. Read when
// AppModule loads: before the imports run.
vi.hoisted(() => {
  process.env.RATE_LIMIT_MULTIPLIER = '20';
});

/**
 * `auth.passwordHistory` (docs/auth.md, "Passwords"): a tenant setting that
 * refuses reusing the account's last N passwords on a change and a reset.
 */
describe('password history (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.admin().delete('/v1/settings/auth.passwordHistory');
  });
  afterAll(() => node.close());

  const setHistory = (value: unknown) =>
    node.admin().put('/v1/settings/auth.passwordHistory').send({ value });

  const change = (
    user: { agent: request.Agent },
    currentPassword: string,
    next: string,
  ) =>
    user.agent
      .post('/v1/auth/password/change')
      .send({ currentPassword, newPassword: next });

  it('is bounded: 0 (off) to 24', async () => {
    for (const value of [-1, 25, 1.5, 'three']) {
      await setHistory(value).expect(400);
    }
    for (const value of [0, 24]) {
      await setHistory(value).expect(200);
    }
  });

  it('is off by default: a password can be changed back and to itself', async () => {
    const user = await node.user(['editor']);
    const second = newPassword();
    await change(user, user.password, second).expect(204);
    await change(user, second, user.password).expect(204);
    await change(user, user.password, user.password).expect(204);
  });

  it('refuses the current password and the previous N - 1 on a change: 422 password_reused', async () => {
    await setHistory(3).expect(200);
    const user = await node.user(['editor']);
    const p1 = user.password;
    const [p2, p3, p4] = [newPassword(), newPassword(), newPassword()];

    // The current password counts, though no history was kept yet.
    const same = await change(user, p1, p1).expect(422);
    expect(same.body).toMatchObject({
      code: 'password_reused',
      history: 3,
      errors: [{ path: 'newPassword' }],
    });

    await change(user, p1, p2).expect(204);
    await change(user, p2, p3).expect(204);
    // The last 3: p3 (current), p2, p1.
    for (const reused of [p3, p2, p1]) {
      const refused = await change(user, p3, reused).expect(422);
      expect(refused.body.code).toBe('password_reused');
    }
    // p4 is new; then p1 falls out of the last 3 (p4, p3, p2).
    await change(user, p3, p4).expect(204);
    await change(user, p4, p3).expect(422);
    await change(user, p4, p2).expect(422);
    await change(user, p4, p1).expect(204);
    // The password is still the account's: it signs in.
    await node.signIn(user.email, p1);
  });

  it('1 forbids only the current password; a lower count forgets older ones', async () => {
    const user = await node.user(['editor']);
    const p1 = user.password;
    const p2 = newPassword();
    const p3 = newPassword();
    await setHistory(3).expect(200);
    await change(user, p1, p2).expect(204);

    await setHistory(1).expect(200);
    await change(user, p2, p2).expect(422);
    // p1 is free again at 1, and the change drops the kept history.
    await change(user, p2, p1).expect(204);
    await setHistory(3).expect(200);
    await change(user, p1, p3).expect(204);
    // p2 was replaced while the count was 1: not remembered. p1 is.
    await change(user, p3, p1).expect(422);
    await change(user, p3, p2).expect(204);
  });

  it('applies to a reset: refused before the link is spent, which then still works', async () => {
    await setHistory(2).expect(200);
    const user = await node.user(['editor']);
    const p2 = newPassword();
    await change(user, user.password, p2).expect(204);

    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: user.email })
      .expect(202);
    const mail = await node.waitForMail({
      to: user.email,
      subject: /Reset your password/,
    });
    const token = mail.link('/reset-password').searchParams.get('token');
    for (const reused of [p2, user.password]) {
      const refused = await node
        .http()
        .post('/v1/auth/password/reset')
        .send({ token, password: reused })
        .expect(422);
      expect(refused.body).toMatchObject({
        code: 'password_reused',
        errors: [{ path: 'password' }],
      });
    }
    const fresh = newPassword();
    await node
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: fresh })
      .expect((r) => console.log('RESET', r.status, JSON.stringify(r.body)));
    await node.signIn(user.email, fresh);
    // The reset replaced p2: it is in the history now (fresh signs in again).
    const again = await node.signIn(user.email, fresh);
    await change({ agent: again }, fresh, p2).expect(422);
  });

  it("is the tenant's choice: another tenant's members are free", async () => {
    const tenant = await node.otherTenant();
    const user = await tenant.user(['editor']);
    await setHistory(5).expect(200);
    await change(user, user.password, user.password).expect(204);
  });
});
