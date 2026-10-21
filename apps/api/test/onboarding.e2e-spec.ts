import { PasswordHasher } from '@nestjs/authentication';
import { eq } from 'drizzle-orm';
import { AccessSeeder } from '../src/iam/access/access.seeder.js';
import { users } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp } from './support.js';

// The suites run with ADMIN_ONBOARDING=off (setup-env.ts); this one seeds the
// administrator as a template deployment does: the placeholder address.
// Read when AppModule loads.
vi.hoisted(() => {
  process.env.ADMIN_ONBOARDING = 'on';
});

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

  let adminId = '';

  it('asks for a real address first: only the onboarding routes answer', async () => {
    const admin = node.admin();
    const me = await admin.get('/v1/auth/me').expect(200);
    adminId = me.body.user.id;
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
    await node.db
      .update(users)
      .set({ onboardingPassword: true })
      .where(eq(users.id, adminId));
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
    await node.db
      .update(users)
      .set({
        email: 'typo@acme-corp.dev',
        emailVerified: false,
        onboardingEmail: true,
      })
      .where(eq(users.id, adminId));
    const admin = await node.signIn('typo@acme-corp.dev', NEW_PASSWORD);
    await admin.get('/v1/auth/me').expect(200);
  });

  it('keeps the password step when a sign-in only rehashes the same password', async () => {
    // A hash made with other scrypt costs than the app's (the e2e app's are
    // logN 10): the sign-in stores a fresh one while it has the plaintext.
    const stale = await new PasswordHasher({ logN: 11 }).hash(NEW_PASSWORD);
    await node.db
      .update(users)
      .set({
        email: REAL,
        emailVerified: true,
        onboardingEmail: false,
        onboardingPassword: true,
        passwordHash: stale,
      })
      .where(eq(users.id, adminId));
    const admin = await node.signIn(REAL, NEW_PASSWORD);
    const [row] = await node.db
      .select({
        passwordHash: users.passwordHash,
        onboardingPassword: users.onboardingPassword,
      })
      .from(users)
      .where(eq(users.id, adminId));
    expect(row.passwordHash).not.toBe(stale);
    expect(row.passwordHash).toMatch(/^\$scrypt\$ln=10,/);
    expect(row.onboardingPassword).toBe(true);
    expect(
      (await admin.get('/v1/auth/me').expect(200)).body.onboardingRequired,
    ).toEqual({ email: false, password: true });
  });

  it('flags an administrator seeded before onboarding existed, at the next start', async () => {
    const seeder = node.app.get(AccessSeeder);
    const flagged = () =>
      node.db
        .select({ onboardingEmail: users.onboardingEmail })
        .from(users)
        .where(eq(users.id, adminId))
        .then(([row]) => row.onboardingEmail);
    const entries = () =>
      node.auditEntries({
        action: 'user.onboarding-required',
        targetId: adminId,
      });
    const holdPlaceholder = (changes: Partial<typeof users.$inferInsert>) =>
      node.db
        .update(users)
        .set({
          email: 'admin@example.com',
          emailVerified: true,
          onboardingEmail: false,
          onboardingPassword: false,
          ...changes,
        })
        .where(eq(users.id, adminId));

    // Unverified: not the seeded account, never flagged (the flag lets an
    // unproved address sign in).
    await holdPlaceholder({ emailVerified: false });
    await seeder.onModuleInit();
    expect(await flagged()).toBe(false);

    // The placeholder address, nothing pending: the start flags it, once.
    await holdPlaceholder({});
    await seeder.onModuleInit();
    expect(await flagged()).toBe(true);
    expect(await entries()).toHaveLength(1);
    await seeder.onModuleInit();
    expect(await entries()).toHaveLength(1);
    const admin = await node.signIn(process.env.ADMIN_EMAIL!, NEW_PASSWORD);
    expect(
      (await admin.get('/v1/auth/me').expect(200)).body.onboardingRequired,
    ).toEqual({ email: true, password: false });
    await admin.get('/v1/access/roles').expect(403);

    // A real address (onboarding done): nothing matches, nothing is reopened.
    await holdPlaceholder({ email: REAL });
    await seeder.onModuleInit();
    expect(await flagged()).toBe(false);
  });
});
