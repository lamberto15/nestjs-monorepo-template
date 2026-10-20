import { eq } from 'drizzle-orm';
import { users } from '../src/iam/iam.tables.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootApp, newPassword, totp, type TestApp } from './support.js';

/** The token in an email's link. */
const tokenOf = (mail: { link: (match?: string) => URL }, path: string) =>
  mail.link(path).searchParams.get('token')!;

describe('accounts (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  const browser = () => request.agent(node.app.getHttpServer());
  const email = () => `${randomUUID().slice(0, 8)}@example.com`;
  /** Something that is not the right credential, made up per call. */
  const wrong = () => randomUUID();

  /** A user who accepted an invitation: verified address, own password, signed in. */
  async function invitedUser(roleKeys: string[] = []) {
    const user = await node.user(roleKeys);
    return { ...user, agent: user.agent };
  }

  it('says how users can sign in', async () => {
    const methods = await node.http().get('/v1/auth/methods').expect(200);
    expect(methods.body).toEqual({
      password: true,
      signUp: false,
      tenantSignUp: false,
      magicLink: true,
      passkeys: true,
      providers: [],
      // Bot protection is off in every e2e file but its own (CAPTCHA_MODE unset).
      captcha: null,
    });
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: email(), name: 'X', password: newPassword() })
      .expect(403);
    await node.http().get('/v1/auth/oidc/google/login').expect(404);
  });

  it('invites a user by email; the link sets a password and verifies the address', async () => {
    const user = await invitedUser();
    const invitation = node.mailbox.assertSent({
      to: user.email,
      subject: /invited you to/,
    });
    expect(invitation.subject).toBe(
      'admin@example.com invited you to Default on nestjs-monorepo-template',
    );
    expect(invitation.link('/accept-invitation').origin).toBe(
      'https://web.example.com',
    );

    const me = await user.agent.get('/v1/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      email: user.email,
      emailVerified: true,
      locale: null,
      timezone: null,
    });
    expect(me.body.mfaEnabled).toBe(false);
  });

  it('resets a forgotten password once, and signs the account out everywhere', async () => {
    const user = await invitedUser();
    // The answer is the same with or without an account.
    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: 'nobody@example.com' })
      .expect(202);
    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: user.email })
      .expect(202);
    const mail = await node.waitForMail({
      to: user.email,
      subject: /Reset your password|Passwort zurücksetzen/,
    });
    expect(node.mailbox.find({ to: 'nobody@example.com' })).toBeUndefined();

    const token = tokenOf(mail, '/reset-password');
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password })
      .expect(204);
    await node
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: newPassword() })
      .expect(400);
    await user.agent.get('/v1/auth/me').expect(401);
    await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email: user.email, password: user.password })
      .expect(401);
    await node.signIn(user.email, password);
  });

  it('changes a password with the current one, keeping only this browser signed in', async () => {
    const user = await invitedUser();
    const other = await node.signIn(user.email, user.password);
    await user.agent
      .post('/v1/auth/password/change')
      .send({ currentPassword: wrong(), newPassword: newPassword() })
      .expect(403);
    await user.agent
      .post('/v1/auth/password/change')
      .send({ currentPassword: user.password, newPassword: newPassword() })
      .expect(204);
    await user.agent.get('/v1/auth/me').expect(200);
    await other.get('/v1/auth/me').expect(401);
  });

  it('keeps the language and time zone a user chose, for answers and emails', async () => {
    const user = await invitedUser();
    await user.agent
      .patch('/v1/auth/me')
      .send({ timezone: 'Mars/Olympus' })
      .expect(400);
    await user.agent.patch('/v1/auth/me').send({ locale: 'fr' }).expect(400);
    const updated = await user.agent
      .patch('/v1/auth/me')
      .send({ locale: 'de', timezone: 'Asia/Manila' })
      .expect(200);
    expect(updated.body).toMatchObject({
      locale: 'de',
      timezone: 'Asia/Manila',
    });
    expect(updated.headers['content-language']).toBe('de');

    // Her own requests are answered in German, whatever her browser says.
    const invalid = await user.agent
      .patch('/v1/auth/me')
      .send({ name: '' })
      .expect(400);
    expect(invalid.headers['content-language']).toBe('de');

    node.mailbox.clear();
    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: user.email })
      .expect(202);
    const mail = await node.waitForMail({
      to: user.email,
      subject: /Reset your password|Passwort zurücksetzen/,
    });
    expect(mail.subject).toBe('Passwort zurücksetzen');
    expect(mail.message.html).toContain('Neues Passwort wählen');
    // The expiry shows in her time zone (UTC+8).
    expect(mail.message.html).toMatch(/GMT\+8|UTC\+8|PHT/);
  });

  it('speaks Arabic (right to left), Chinese and Malay, with regional formats', async () => {
    const ar = await node
      .http()
      .post('/v1/auth/sign-in')
      .set('Accept-Language', 'ar-AE')
      .send({ email: 'nope', password: 'x' })
      .expect(400);
    expect(ar.headers['content-language']).toBe('ar-AE');
    expect(ar.body.errors).toContainEqual({
      path: 'email',
      message: 'يجب أن يكون email عنوان بريد إلكتروني',
    });
    const zh = await node
      .http()
      .post('/v1/auth/sign-in?lang=zh-SG')
      .send({ email: 'nope', password: 'x' })
      .expect(400);
    expect(zh.headers['content-language']).toBe('zh-SG');
    expect(zh.body.errors).toContainEqual({
      path: 'email',
      message: 'email 必须是电子邮件地址',
    });

    const user = await invitedUser();
    await user.agent
      .patch('/v1/auth/me')
      .send({ locale: 'ar-AE', timezone: 'Asia/Dubai' })
      .expect(200);
    node.mailbox.clear();
    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: user.email })
      .expect(202);
    const mail = await node.waitForMail({
      to: user.email,
      subject: 'إعادة تعيين كلمة المرور',
    });
    expect(mail.message.html).toContain('dir="rtl"');
    expect(mail.message.html).toContain('اختيار كلمة مرور جديدة');

    await user.agent.patch('/v1/auth/me').send({ locale: 'ms' }).expect(200);
    node.mailbox.clear();
    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: user.email })
      .expect(202);
    await node.waitForMail({
      to: user.email,
      subject: 'Tetapkan semula kata laluan anda',
    });
  });

  it('verifies an address with the link the user asks for', async () => {
    const { agent, id, password } = await node.user([]);
    // An address not proved (an invitation's acceptance proves it: undone
    // here, as for an account that signed up).
    await node.db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, id));
    const me = await agent.get('/v1/auth/me').expect(200);
    expect(me.body.user.emailVerified).toBe(false);
    await agent.post('/v1/auth/email/verification').expect(202);
    const mail = await node.waitForMail({
      to: me.body.user.email,
      subject: 'Confirm your email address',
    });
    await node
      .http()
      .post('/v1/auth/email/verify')
      .send({ token: wrong() })
      .expect(400);
    await node
      .http()
      .post('/v1/auth/email/verify')
      // The account has a password its owner never proved: it goes along.
      .send({ token: tokenOf(mail, '/verify-email'), password })
      .expect(200, { email: me.body.user.email, emailVerified: true });
    const after = await agent.get('/v1/auth/me').expect(200);
    expect(after.body.user).toMatchObject({ id, emailVerified: true });
  });

  it('turns on two-factor: a sign-in then needs a code', async () => {
    const user = await invitedUser();
    const enrollment = await user.agent.post('/v1/auth/mfa/enroll').expect(200);
    expect(enrollment.body.uri).toMatch(/^otpauth:\/\/totp\//);
    await user.agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: '000000' })
      .expect(400);
    const confirmed = await user.agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(enrollment.body.secret) })
      .expect(200);
    expect(confirmed.body.recoveryCodes).toHaveLength(10);
    const [first, second] = confirmed.body.recoveryCodes as string[];

    const browserB = browser();
    const signedIn = await browserB
      .post('/v1/auth/sign-in')
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect(signedIn.body).toEqual({ signedIn: false, mfaRequired: true });
    await browserB.get('/v1/auth/me').expect(401);
    await browserB
      .post('/v1/auth/mfa/verify')
      .send({ code: '123456' })
      .expect(401);
    await browserB
      .post('/v1/auth/mfa/verify')
      .send({ recoveryCode: first })
      .expect(200, { signedIn: true, mfaRequired: false });
    const me = await browserB.get('/v1/auth/me').expect(200);
    expect(me.body.mfaEnabled).toBe(true);

    // Token clients need a code too.
    const noCode = await node
      .http()
      .post('/v1/auth/token')
      .send({ email: user.email, password: user.password })
      .expect(401);
    expect(JSON.stringify(noCode.body)).toContain('mfa_required');
    await node
      .http()
      .post('/v1/auth/token')
      .send({
        email: user.email,
        password: user.password,
        recoveryCode: second,
      })
      .expect(200);
  });

  it('lists sessions and signs one out, or all of them', async () => {
    const user = await invitedUser();
    const other = await node.signIn(user.email, user.password);
    const sessions = await user.agent.get('/v1/auth/sessions').expect(200);
    expect(sessions.body.items).toHaveLength(2);
    const otherSession = sessions.body.items.find(
      (session: { current: boolean }) => !session.current,
    );
    await user.agent.delete(`/v1/auth/sessions/${otherSession.id}`).expect(204);
    await other.get('/v1/auth/me').expect(401);
    // The readable device comes from the recorded user agent; null with none.
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    await browser()
      .post('/v1/auth/sign-in')
      .set('User-Agent', chrome)
      .send({ email: user.email, password: user.password })
      .expect(200);
    const listed = (await user.agent.get('/v1/auth/sessions').expect(200)).body
      .items as { userAgent: string | null; device: string | null }[];
    expect(listed.find((item) => item.userAgent === chrome)?.device).toBe(
      'Chrome on macOS',
    );
    expect(
      listed.every((item) => item.device === null || item.userAgent !== null),
    ).toBe(true);
    await user.agent.post('/v1/auth/sign-out-everywhere').expect(204);
    await user.agent.get('/v1/auth/me').expect(401);
  });

  it('issues tokens to mobile apps, rotates them, and revokes a family on reuse', async () => {
    const user = await invitedUser();
    const issued = await node
      .http()
      .post('/v1/auth/token')
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect(issued.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
    });
    const me = await node
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${issued.body.accessToken}`)
      .expect(200);
    expect(me.body.user.id).toBe(user.id);

    const first = issued.body.refreshToken as string;
    const refreshed = await node
      .http()
      .post('/v1/auth/token/refresh')
      .send({ refreshToken: first })
      .expect(200);
    const second = refreshed.body.refreshToken as string;
    // The first refresh token, presented again: someone copied it. The whole family goes.
    await node
      .http()
      .post('/v1/auth/token/refresh')
      .send({ refreshToken: first })
      .expect(401);
    await node
      .http()
      .post('/v1/auth/token/refresh')
      .send({ refreshToken: second })
      .expect(401);
  });

  it('signs in by email link, in the browser that asked for it only', async () => {
    const user = await invitedUser();
    const asking = browser();
    await asking
      .post('/v1/auth/magic-link')
      .send({ email: user.email, redirectTo: '/inbox' })
      .expect(202);
    await asking
      .post('/v1/auth/magic-link')
      .send({ email: 'nobody@example.com' })
      .expect(202);
    const mail = await node.waitForMail({
      to: user.email,
      subject: 'Your sign-in link',
    });
    const token = tokenOf(mail, '/magic-link');

    await browser()
      .post('/v1/auth/magic-link/verify')
      .send({ token })
      .expect(401);
    const signedIn = await asking
      .post('/v1/auth/magic-link/verify')
      .send({ token })
      .expect(200);
    expect(signedIn.body).toEqual({
      signedIn: true,
      mfaRequired: false,
      redirectTo: '/inbox',
    });
    await asking.get('/v1/auth/me').expect(200);
  });

  it('lets an administrator act as a user, audited, without touching their credentials', async () => {
    const user = await invitedUser(['editor']);
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    const adminId = (await admin.get('/v1/auth/me').expect(200)).body.user.id;

    await admin.post(`/v1/access/users/${adminId}/impersonate`).expect(409);
    await admin.post(`/v1/access/users/${user.id}/impersonate`).expect(204);
    const me = await admin.get('/v1/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      id: user.id,
      impersonator: { id: adminId, email: 'admin@example.com' },
    });
    expect(me.body.can['Access.manageUsers']).toBe(false);

    // The account's credentials stay the user's.
    await admin
      .post('/v1/auth/password/change')
      .send({ currentPassword: user.password, newPassword: newPassword() })
      .expect(403);
    await admin.post('/v1/auth/sign-out-everywhere').expect(403);

    await admin.post('/v1/auth/impersonation/stop').expect(204);
    const back = await admin.get('/v1/auth/me').expect(200);
    expect(back.body.user.id).toBe(adminId);
    expect(back.body.user.impersonator).toBeUndefined();

    const audit = await admin.get('/v1/access/audit').expect(200);
    const actions = audit.body.items.map(
      (entry: { action: string }) => entry.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.impersonation-started',
        'user.impersonation-stopped',
      ]),
    );
  });

  it('never impersonates an administrator', async () => {
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    const other = await node.user(['administrator']);
    await admin.post(`/v1/access/users/${other.id}/impersonate`).expect(403);
  });
});
