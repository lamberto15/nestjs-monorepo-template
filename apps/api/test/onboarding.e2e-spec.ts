import { eq } from 'drizzle-orm';
import { users } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp } from './support.js';

// The suites run with ADMIN_ONBOARDING=off (setup-env.ts); this one seeds the
// administrator as a template deployment does: the placeholder address.
process.env.ADMIN_ONBOARDING = 'on';

/**
 * The first administrator's onboarding (docs/auth.md, "Administrator
 * onboarding"): the placeholder address and a generated password are
 * replaced before anything else is reachable.
 */
describe('administrator onboarding (e2e)', () => {
  let node: TestApp;
  const REAL = 'owner@acme-corp.dev';
  const NEW_PASSWORD = 'a-brand-new-passphrase-2026';

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(() => node.close());

  const adminRow = async () =>
    (
      await node.db
        .select()
        .from(users)
        .where(eq(users.email, process.env.ADMIN_EMAIL!))
    )[0];

  it('asks for a real address first: only the onboarding routes answer', async () => {
    const admin = node.admin();
    const me = await admin.get('/v1/auth/me').expect(200);
    expect(me.body.onboardingRequired).toEqual({
      email: true,
      password: false,
    });
    const refused = await admin.get('/v1/access/roles').expect(403);
    expect(refused.body.code).toBe('onboarding_required');
    // What the step needs stays reachable.
    await admin.get('/v1/features').expect(200);
    await admin.get('/v1/auth/mfa').expect(200);
  });

  it('refuses a placeholder, a wrong password and keeps the rest blocked', async () => {
    const admin = node.admin();
    await admin
      .post('/v1/auth/email/change')
      .send({
        email: 'someone@example.com',
        currentPassword: process.env.ADMIN_PASSWORD,
      })
      .expect(400);
    await admin
      .post('/v1/auth/email/change')
      .send({ email: REAL, currentPassword: 'not-the-password-at-all' })
      .expect(403);
    await admin.get('/v1/access/roles').expect(403);
  });

  it('changes the address, proves it with the link, and opens the rest', async () => {
    const admin = node.admin();
    await admin
      .post('/v1/auth/email/change')
      .send({ email: REAL, currentPassword: process.env.ADMIN_PASSWORD })
      .expect(202);
    const pending = await admin.get('/v1/auth/me').expect(200);
    expect(pending.body.user).toMatchObject({
      email: REAL,
      emailVerified: false,
    });
    expect(pending.body.onboardingRequired).toEqual({
      email: true,
      password: false,
    });
    const mail = await node.waitForMail({
      to: REAL,
      subject: 'Confirm your email address',
    });
    await node
      .http()
      .post('/v1/auth/email/verify')
      .send({
        token: mail.link('/verify-email').searchParams.get('token'),
        password: process.env.ADMIN_PASSWORD,
      })
      .expect(200);
    const done = await admin.get('/v1/auth/me').expect(200);
    expect(done.body.onboardingRequired).toBeNull();
    await admin.get('/v1/access/roles').expect(200);
    // The route is for the onboarding only.
    await admin
      .post('/v1/auth/email/change')
      .send({
        email: 'again@acme-corp.dev',
        currentPassword: process.env.ADMIN_PASSWORD,
      })
      .expect(409);
  });

  it('changing the generated password ends the password step, with two-factor required alongside', async () => {
    const row = await adminRow();
    await node.db
      .update(users)
      .set({ onboardingPassword: true })
      .where(eq(users.id, row!.id));
    const admin = await node.signIn(REAL, process.env.ADMIN_PASSWORD!);
    expect(
      (await admin.get('/v1/auth/me').expect(200)).body.onboardingRequired,
    ).toEqual({ email: false, password: true });
    await admin.get('/v1/access/roles').expect(403);
    // Both guards at once must not lock each other: the password route answers.
    await admin
      .post('/v1/auth/password/change')
      .send({
        currentPassword: process.env.ADMIN_PASSWORD,
        newPassword: NEW_PASSWORD,
      })
      .expect(204);
    expect(
      (await admin.get('/v1/auth/me').expect(200)).body.onboardingRequired,
    ).toBeNull();
    await admin.get('/v1/access/roles').expect(200);
    await admin.post('/v1/auth/sign-out').expect(204);
  });

  it('lets a mistyped, unproved address still sign in (no lock-out) while onboarding asks', async () => {
    const row = await adminRow();
    await node.db
      .update(users)
      .set({
        email: 'typo@acme-corp.dev',
        emailVerified: false,
        onboardingEmail: true,
      })
      .where(eq(users.id, row!.id));
    const admin = await node.signIn('typo@acme-corp.dev', NEW_PASSWORD);
    await admin.get('/v1/auth/me').expect(200);
  });
});
