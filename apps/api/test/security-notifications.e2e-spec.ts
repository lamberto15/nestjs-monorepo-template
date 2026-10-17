import { randomUUID } from 'node:crypto';
import { OutboxRelay } from '@nestjs/outbox';
import { eq } from 'drizzle-orm';
import { users } from '../src/iam/iam.tables.js';
import request from 'supertest';
import { bootApp, newPassword, totp, type TestApp } from './support.js';

const CHROME_MAC = (version: number) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;

/** The token in an email's link. */
const tokenOf = (mail: { link: (match?: string) => URL }, path: string) =>
  mail.link(path).searchParams.get('token')!;

interface Item {
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  count: number;
}

describe('security notifications (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  /** Hands committed outbox messages to the delivery handler (the worker's job). */
  const deliver = () => node.app.get(OutboxRelay).runOnce();

  /** A user who accepted an invitation (their own password), not signed in yet. */
  async function account() {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const token = await node.invite(node.admin(), { email });
    const password = await node.acceptAsNew(token, email);
    return { email, password };
  }

  /** Signs in from a browser that sends this User-Agent. */
  async function signInFrom(
    userAgent: string,
    user: { email: string; password: string },
  ) {
    const agent = request.agent(node.app.getHttpServer());
    await agent
      .post('/v1/auth/sign-in')
      .set('User-Agent', userAgent)
      .send(user)
      .expect(200);
    return agent;
  }

  /** The signed-in user's id. */
  const idOf = async (agent: request.Agent) =>
    (await agent.get('/v1/auth/me').expect(200)).body.user.id as string;

  /** The caller's security notifications, after delivery. */
  async function securityItems(agent: request.Agent) {
    await deliver();
    const response = await agent
      .get('/v1/notifications?sort=-createdAt')
      .expect(200);
    return (response.body.items as Item[]).filter((item) =>
      item.type.startsWith('security.'),
    );
  }

  it('tells a user of a sign-in from a new device, once per device', async () => {
    const user = await account();
    // The first sign-in ever: nothing to compare with, no alert.
    const laptop = await signInFrom('curl/8.7.1', user);
    expect(await securityItems(laptop)).toEqual([]);

    // Another device.
    const chrome = await signInFrom(CHROME_MAC(130), user);
    const [item, ...rest] = await securityItems(chrome);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      type: 'security.newSignIn',
      title: 'New sign-in to your account',
      count: 1,
      data: { device: 'Chrome on macOS', ip: '127.0.0.1' },
    });
    expect(item!.body).toContain('Chrome on macOS (127.0.0.1)');
    const mail = await node.waitForMail({
      to: user.email,
      subject: /New sign-in/,
    });
    expect(mail.text ?? mail.html).toContain('Chrome on macOS');

    // The same device again, even after a browser update, and the first one: no news.
    await signInFrom(CHROME_MAC(131), user);
    await signInFrom('curl/8.8.0', user);
    const after = await securityItems(chrome);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ type: 'security.newSignIn', count: 1 });
    expect(
      node.mailbox.filter({ to: user.email, subject: /New sign-in/ }),
    ).toHaveLength(1);

    // The audit entry carries the device.
    const audit = await node.auditEntries({ action: 'auth.signed-in' });
    expect(audit[0]!.details).toMatchObject({
      device: expect.stringMatching(/^[0-9a-f]{32}$/),
      userAgent: 'curl',
    });
  });

  it('tells nobody of a wrong password, and records no sign-in', async () => {
    const user = await account();
    const agent = await signInFrom('curl/8.7.1', user);
    const signIns = async () =>
      (
        await node.auditEntries({
          action: 'auth.signed-in',
          actor: `user:${await idOf(agent)}`,
        })
      ).length;
    expect(await signIns()).toBe(1);
    await request(node.app.getHttpServer())
      .post('/v1/auth/sign-in')
      .set('User-Agent', CHROME_MAC(130))
      .send({ email: user.email, password: newPassword() })
      .expect(401);
    expect(await signIns()).toBe(1);
    expect(await securityItems(agent)).toEqual([]);
  });

  it('tells a user of a new device when the password was right, two-factor still to do', async () => {
    const user = await account();
    const agent = await signInFrom('curl/8.7.1', user);
    const enrollment = await agent.post('/v1/auth/mfa/enroll').expect(200);
    await agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(enrollment.body.secret) })
      .expect(200);
    const chrome = request.agent(node.app.getHttpServer());
    const pending = await chrome
      .post('/v1/auth/sign-in')
      .set('User-Agent', CHROME_MAC(130))
      .send(user)
      .expect(200);
    expect(pending.body).toEqual({ signedIn: false, mfaRequired: true });
    const items = await securityItems(agent);
    expect(items.map((item) => item.type)).toEqual([
      'security.newSignIn',
      'security.mfaChanged',
    ]);
    await node.waitForMail({ to: user.email, subject: /New sign-in/ });
  });

  it('tells a user of a new device signing in by email link, or as a token client', async () => {
    const user = await account();
    const first = await signInFrom(CHROME_MAC(130), user);
    const userId = await idOf(first);
    // Email links go to verified addresses only (as an accepted invitation leaves one).
    await node.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, userId));
    const signIns = async () =>
      (await node.auditEntries({
        action: 'auth.signed-in',
        actor: `user:${userId}`,
      })) as { details: Record<string, unknown> }[];

    // An email link, opened in the browser that asked for it: another device.
    const phone = request.agent(node.app.getHttpServer());
    const SAFARI_IOS =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    await phone
      .post('/v1/auth/magic-link')
      .set('User-Agent', SAFARI_IOS)
      .send({ email: user.email })
      .expect(202);
    const mail = await node.waitForMail({
      to: user.email,
      subject: 'Your sign-in link',
    });
    await phone
      .post('/v1/auth/magic-link/verify')
      .set('User-Agent', SAFARI_IOS)
      .send({ token: tokenOf(mail, '/magic-link') })
      .expect(200);
    let items = await securityItems(first);
    expect(items.map((item) => [item.type, item.data.device])).toEqual([
      ['security.newSignIn', 'Safari on iOS'],
    ]);
    expect((await signIns()).map((entry) => entry.details.method)).toEqual([
      'magic-link',
      'password',
    ]);

    // A token client with the password, from a script.
    await request(node.app.getHttpServer())
      .post('/v1/auth/token')
      .set('User-Agent', 'python-requests/2.32')
      .send({ email: user.email, password: user.password })
      .expect(200);
    items = await securityItems(first);
    expect(items.map((item) => item.data.device)).toEqual([
      'python-requests',
      'Safari on iOS',
    ]);
    expect((await signIns())[0]!.details).toMatchObject({
      method: 'password',
      via: 'token',
    });
    // Repeats from either are no news.
    await request(node.app.getHttpServer())
      .post('/v1/auth/token')
      .set('User-Agent', 'python-requests/2.32')
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect((await securityItems(first)).map((item) => item.count)).toEqual([
      1, 1,
    ]);
  });

  it('tells a user their password changed: by them, or with a reset link', async () => {
    const user = await account();
    const agent = await signInFrom('curl/8.7.1', user);
    const changed = newPassword();
    await agent
      .post('/v1/auth/password/change')
      .send({ currentPassword: user.password, newPassword: changed })
      .expect(204);
    const [item] = await securityItems(agent);
    expect(item).toMatchObject({
      type: 'security.passwordChanged',
      title: 'Your password was changed',
      data: { via: 'change', ip: '127.0.0.1' },
    });
    await node.waitForMail({ to: user.email, subject: /password was changed/ });

    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: user.email })
      .expect(202);
    const reset = await node.waitForMail({
      to: user.email,
      subject: /Reset your password/,
    });
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/password/reset')
      .send({ token: tokenOf(reset, '/reset-password'), password })
      .expect(204);
    const again = await signInFrom('curl/8.7.1', { ...user, password });
    const items = await securityItems(again);
    expect(items.map((i) => [i.type, i.data.via])).toEqual([
      ['security.passwordChanged', 'reset'],
      ['security.passwordChanged', 'change'],
    ]);
  });

  it("doesn't tell an invited user that their first password was set", async () => {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const token = await node.invite(node.admin(), { email, name: 'Ada' });
    const password = await node.acceptAsNew(token);
    const agent = await signInFrom('curl/8.7.1', { email, password });
    expect(await securityItems(agent)).toEqual([]);
  });

  it('tells a user when two-factor is turned on and off', async () => {
    const user = await account();
    const agent = await signInFrom('curl/8.7.1', user);
    const enrollment = await agent.post('/v1/auth/mfa/enroll').expect(200);
    await agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(enrollment.body.secret) })
      .expect(200);
    const [on] = await securityItems(agent);
    expect(on).toMatchObject({
      type: 'security.mfaChanged',
      data: { enabled: true, ip: '127.0.0.1' },
    });
    await node.waitForMail({ to: user.email, subject: /Two-factor/ });

    await agent.delete('/v1/auth/mfa').expect(204);
    const [off] = await securityItems(agent);
    expect(off).toMatchObject({
      type: 'security.mfaChanged',
      data: { enabled: false },
    });
  });

  it('tells an API client its key was rotated', async () => {
    const client = await node.client();
    await node
      .admin()
      .post(`/v1/access/clients/${client.id}/rotate`)
      .send({ graceSeconds: 60 })
      .expect(200);
    await deliver();
    const items = (
      await node
        .http()
        .get('/v1/notifications')
        .set('Authorization', client.auth)
        .expect(200)
    ).body.items as Item[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'security.apiKeyRotated',
      data: { clientId: client.id, keyId: expect.any(String) },
    });
    // A client can't switch its webhook off for it.
    const refused = await node
      .http()
      .put('/v1/notifications/preferences')
      .set('Authorization', client.auth)
      .send({ 'security.apiKeyRotated': { webhook: false } })
      .expect(400);
    expect(refused.body.code).toBe('validation_failed');
  });

  it('keeps the mail of security notifications on: they are mandatory', async () => {
    const user = await account();
    const agent = await signInFrom('curl/8.7.1', user);
    for (const type of [
      'security.newSignIn',
      'security.passwordChanged',
      'security.mfaChanged',
    ]) {
      const refused = await agent
        .put('/v1/notifications/preferences')
        .send({ [type]: { email: false } })
        .expect(400);
      expect(refused.body.code).toBe('validation_failed');
      expect(
        (refused.body.errors as { path: string }[]).map((e) => e.path),
      ).toEqual([`${type}.email`]);
    }
    // A frequency is the user's to choose.
    await agent
      .put('/v1/notifications/preferences')
      .send({ 'security.newSignIn': { email: 'daily' } })
      .expect(200);

    const types = (await agent.get('/v1/notifications/types').expect(200)).body
      .items as { type: string; mandatory: boolean; channels: object }[];
    expect(types.filter((t) => t.type.startsWith('security.'))).toEqual([
      {
        type: 'security.newSignIn',
        label: 'New sign-in',
        mandatory: true,
        channels: { email: 'immediate' },
      },
      {
        type: 'security.passwordChanged',
        label: 'Password changed',
        mandatory: true,
        channels: { email: 'immediate' },
      },
      {
        type: 'security.mfaChanged',
        label: 'Two-factor sign-in changed',
        mandatory: true,
        channels: { email: 'immediate' },
      },
      {
        type: 'security.apiKeyRotated',
        label: 'API key rotated',
        mandatory: true,
        channels: { email: false },
      },
    ]);
  });
});
