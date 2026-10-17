import { randomUUID } from 'node:crypto';
import request from 'supertest';
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
});
