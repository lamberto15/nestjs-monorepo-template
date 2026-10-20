import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { EmailVerificationService } from '@nestjs/authentication';
import { and, eq } from 'drizzle-orm';
import { VerificationRequests } from '../src/iam/account/verification-requests.service.js';
import { emailTokens, users } from '../src/iam/iam.tables.js';
import { bootApp, newPassword, type TestApp } from './support.js';

// Read when AppModule loads: anyone may sign up in this file.
vi.hoisted(() => {
  process.env.AUTH_SIGN_UP = 'on';
});

/**
 * Self sign-up, verify first (docs/auth.md, "Sign-up"): a password chosen
 * before its address was proved signs nobody in, by session or token, until
 * the address is, and proving it takes that password too. So whoever signs
 * up someone else's address can't have its owner verify it for them, then
 * sign in as the owner (and follow the account into the tenants that
 * invite it).
 */
describe('sign-up, verify first (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  const email = () => `${randomUUID().slice(0, 8)}@example.com`;
  const signUp = (address: string, password: string) =>
    node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: address, name: 'Cfo', password })
      .expect(201);
  const signIn = (address: string, password: string) =>
    node.http().post('/v1/auth/sign-in').send({ email: address, password });
  const verificationToken = async (address: string) =>
    (
      await node.waitForMail({
        to: address,
        subject: 'Confirm your email address',
      })
    )
      .link('/verify-email')
      .searchParams.get('token')!;

  it('signs an unverified sign-up in by no password, until its address is proved with it', async () => {
    const address = email();
    const password = newPassword();
    const browser = request.agent(node.app.getHttpServer());
    await browser
      .post('/v1/auth/sign-up')
      .send({ email: address, name: 'Ada', password })
      .expect(201);
    // No session from the sign-up itself.
    await browser.get('/v1/auth/me').expect(401);
    const refused = await signIn(address, password).expect(403);
    expect(refused.body.code).toBe('email_unverified');
    await node
      .http()
      .post('/v1/auth/token')
      .send({ email: address, password })
      .expect(403);
    // A wrong password is the same 401 as ever: nothing told.
    await signIn(address, newPassword()).expect(401);

    const token = await verificationToken(address);
    const missing = await node
      .http()
      .post('/v1/auth/email/verify')
      .send({ token })
      .expect(400);
    expect(missing.body.code).toBe('password_required');
    await node
      .http()
      .post('/v1/auth/email/verify')
      .send({ token, password: newPassword() })
      .expect(403);
    // The link survived both: verified with the password chosen at sign-up.
    await node
      .http()
      .post('/v1/auth/email/verify')
      .send({ token, password })
      .expect(200);
    await signIn(address, password).expect(200);
  });

  it('leaves the owner of an address someone else signed up, never the one who did', async () => {
    const victim = email();
    const attackerPassword = newPassword();
    await signUp(victim, attackerPassword);
    // The owner opens the verification link they never asked for: the link
    // alone proves the mailbox, not who chose the password, so it verifies
    // nothing (and the attacker still signs in to nothing).
    const token = await verificationToken(victim);
    await node.http().post('/v1/auth/email/verify').send({ token }).expect(400);
    await signIn(victim, attackerPassword).expect(403);

    // The owner takes the address with a reset link (it proves the address
    // and replaces the password)…
    await node
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: victim })
      .expect(202);
    const reset = await node.waitForMail({
      to: victim,
      subject: /Reset your password|invited/,
    });
    const ownPassword = newPassword();
    await node
      .http()
      .post('/v1/auth/password/reset')
      .send({
        token: reset.link('/reset-password').searchParams.get('token'),
        password: ownPassword,
      })
      .expect(204);
    // …then joins a tenant by its invitation, signed in as themselves.
    const owner = await node.signIn(victim, ownPassword);
    const other = await node.otherTenant();
    const invitation = await node.invite(other.admin, { email: victim });
    await owner
      .post('/v1/auth/invitations/accept')
      .send({ token: invitation })
      .expect(200);
    // The attacker's password opens nothing, in any tenant.
    await signIn(victim, attackerPassword).expect(401);
    await node
      .http()
      .post('/v1/auth/token')
      .send({ email: victim, password: attackerPassword, tenantId: other.id })
      .expect(401);
  });

  it('makes no tenant with TENANT_SIGN_UP off (the default): the account joins none, tenantName unused', async () => {
    const methods = await node.http().get('/v1/auth/methods').expect(200);
    expect(methods.body).toMatchObject({ signUp: true, tenantSignUp: false });
    const count = async () =>
      (await node.admin().get('/v1/tenants?count=true').expect(200)).body
        .total as number;
    const before = await count();
    const address = email();
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: address, name: 'Ada', password, tenantName: 'Mine' })
      .expect(201);
    await node.verifySignUp(address, password);
    const agent = await node.signIn(address, password);
    const me = await agent.get('/v1/auth/me').expect(200);
    expect(me.body.tenant).toBeNull();
    const mine = await agent.get('/v1/auth/tenants').expect(200);
    expect(mine.body.items).toEqual([]);
    expect(await count()).toBe(before);
  });

  describe('resending the link without a session (#260)', () => {
    const resend = (address: string, from = '127.0.0.1') =>
      node
        .http()
        .post('/v1/auth/email/verification/resend')
        .set('X-Forwarded-For', from)
        .send({ email: address });
    /** The account's links as if sent a while ago: past the resend's cooldown. */
    const ageLinks = async (address: string) => {
      const [user] = await node.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, address));
      await node.db
        .update(emailTokens)
        .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
        .where(
          and(
            eq(emailTokens.userId, user!.id),
            eq(emailTokens.purpose, 'email-verification'),
          ),
        );
      return user!.id;
    };
    const sendSpy = () =>
      vi.spyOn(node.app.get(EmailVerificationService), 'send');
    const settled = () => node.app.get(VerificationRequests).settled();

    it('answers 202 for an unknown, a verified and an unverified address alike, and mails only the unverified one', async () => {
      const unverified = email();
      const password = newPassword();
      await signUp(unverified, password);
      const userId = await ageLinks(unverified);
      const unknown = email();
      const verified = process.env.ADMIN_EMAIL!;
      const send = sendSpy();

      const answers = [];
      for (const address of [unknown, verified, unverified]) {
        answers.push(await resend(address).expect(202));
      }
      for (const answer of answers) {
        expect(answer.body).toEqual({ accepted: true });
        expect(answer.headers['content-length']).toBe(
          answers[0]!.headers['content-length'],
        );
      }
      await settled();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatchObject({ id: userId });

      // The new link proves the address, with the sign-up's password.
      const mails = () =>
        node.mailbox.filter({
          to: unverified,
          subject: 'Confirm your email address',
        });
      for (let tries = 0; mails().length < 2 && tries < 100; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const latest = mails().at(-1)!;
      await node
        .http()
        .post('/v1/auth/email/verify')
        .send({
          token: latest.link('/verify-email').searchParams.get('token'),
          password,
        })
        .expect(200);
      await signIn(unverified, password).expect(200);
      expect(node.mailbox.filter({ to: unknown })).toHaveLength(0);
      expect(
        node.mailbox.filter({
          to: verified,
          subject: 'Confirm your email address',
        }),
      ).toHaveLength(0);
      send.mockRestore();
    });

    it('sends at most one link a minute per account, the sign-up’s own counting', async () => {
      const address = email();
      await signUp(address, newPassword());
      const send = sendSpy();
      // Right after the sign-up's link: the same 202, no second link.
      await resend(address, '10.0.0.1').expect(202);
      await settled();
      expect(send).not.toHaveBeenCalled();
      await ageLinks(address);
      await resend(address, '10.0.0.2').expect(202);
      await resend(address, '10.0.0.3').expect(202);
      await settled();
      expect(send).toHaveBeenCalledTimes(1);
      send.mockRestore();
    });

    it('limits it to 5 requests per email and IP every 15 minutes', async () => {
      const address = email();
      for (let i = 0; i < 5; i++) {
        await resend(address, '10.0.1.1').expect(202);
      }
      const refused = await resend(address, '10.0.1.1').expect(429);
      expect(refused.body.code).toBe('rate_limited');
      // Another address from the same IP isn't refused.
      await resend(email(), '10.0.1.1').expect(202);
      await settled();
    });

    it('refuses a body without a valid email', async () => {
      await node
        .http()
        .post('/v1/auth/email/verification/resend')
        .send({ email: 'not-an-email' })
        .expect(400);
      await node
        .http()
        .post('/v1/auth/email/verification/resend')
        .send({})
        .expect(400);
    });
  });
});
