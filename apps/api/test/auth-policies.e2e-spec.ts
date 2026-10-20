import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type request from 'supertest';
import { bootApp, newPassword, totp, type TestApp } from './support.js';

/**
 * The auth policies a tenant's administrators set (docs/auth.md,
 * "Policies"): `auth.requireMfa` and `auth.passwordMinLength`, under the
 * environment's ceiling.
 */
describe('auth policies (e2e)', () => {
  let node: TestApp;
  let off: string[];

  beforeAll(async () => {
    node = await bootApp();
    // AUTH_MFA turned off while the app runs, as the switches' tests do.
    const config = node.app.get(ConfigService);
    const read = config.get.bind(config) as (...args: unknown[]) => unknown;
    vi.spyOn(config, 'get').mockImplementation(((key: string, ...rest: []) =>
      off.includes(key) ? false : read(key, ...rest)) as never);
  });
  beforeEach(() => {
    off = [];
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await node.close();
  });

  const longPassword = (length: number) =>
    randomBytes(length).toString('base64url').slice(0, length);

  /** A team of the seeded tenant with this member. */
  async function teamWith(userId: string) {
    const admin = node.admin();
    const team = await admin
      .post('/v1/access/teams')
      .send({ name: `team-${randomBytes(4).toString('hex')}` })
      .expect(201);
    await admin
      .patch(`/v1/access/users/${userId}`)
      .send({ teamIds: [team.body.id] })
      .expect(204);
    return team.body.id as string;
  }

  /** Sets up and confirms an authenticator for the agent's user. */
  async function enroll(agent: request.Agent) {
    const enrollment = await agent.post('/v1/auth/mfa/enroll').expect(200);
    await agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(enrollment.body.secret) })
      .expect(200);
    return enrollment.body.secret as string;
  }

  describe('auth.requireMfa', () => {
    it('restricts a team member without two-factor to enrollment until enrolled, then a normal session', async () => {
      const member = await node.user(['editor']);
      const other = await node.user(['editor']);
      const team = await teamWith(member.id);
      await node
        .admin()
        .put('/v1/settings/auth.requireMfa')
        .send({ scope: 'team', scopeId: team, value: true })
        .expect(200);

      // The first factor signs in as usual: no code to ask for yet.
      const signedIn = await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: member.email, password: member.password })
        .expect(200);
      expect(signedIn.body).toMatchObject({
        signedIn: true,
        mfaRequired: false,
      });
      const agent = await node.signIn(member.email, member.password);
      const me = await agent.get('/v1/auth/me').expect(200);
      expect(me.body.mfaEnrollmentRequired).toBe(true);
      // Every other route says why.
      const refused = await agent.get('/v1/test-items').expect(403);
      expect(refused.body).toMatchObject({ code: 'mfa_enrollment_required' });
      await agent.get('/v1/settings').expect(403);
      await agent.get('/v1/auth/sessions').expect(403);
      // So does a session signed in before the policy (checked per request).
      await member.agent.get('/v1/test-items').expect(403);
      // A token client of the same user too.
      const tokens = await node
        .http()
        .post('/v1/auth/token')
        .send({ email: member.email, password: member.password })
        .expect(200);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', `Bearer ${tokens.body.accessToken}`)
        .expect(403);
      // What enrolling needs stays open.
      await agent.get('/v1/auth/mfa').expect(200);
      await agent.get('/v1/auth/reauthenticate').expect(200);
      await agent.get('/v1/auth/tenants').expect(200);

      // Someone outside the team: nothing changes.
      await other.agent.get('/v1/test-items').expect(200);
      expect(
        (await other.agent.get('/v1/auth/me').expect(200)).body
          .mfaEnrollmentRequired,
      ).toBe(false);

      // Once enrolled, the same session is a normal one.
      await enroll(agent);
      await agent.get('/v1/test-items').expect(200);
      expect(
        (await agent.get('/v1/auth/me').expect(200)).body.mfaEnrollmentRequired,
      ).toBe(false);
      // And the next sign-in asks for the code, as for anyone enrolled.
      const next = await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: member.email, password: member.password })
        .expect(200);
      expect(next.body).toMatchObject({ signedIn: false, mfaRequired: true });

      await agent.post('/v1/auth/sign-out').expect(204);
    });

    it('off: back to normal; not settable per user', async () => {
      const member = await node.user(['editor']);
      const team = await teamWith(member.id);
      const admin = node.admin();
      await admin
        .put('/v1/settings/auth.requireMfa')
        .send({ scope: 'team', scopeId: team, value: true })
        .expect(200);
      await member.agent.get('/v1/test-items').expect(403);
      await admin
        .delete(`/v1/settings/auth.requireMfa?scope=team&scopeId=${team}`)
        .expect(204);
      await member.agent.get('/v1/test-items').expect(200);

      // Nobody exempts themselves, nor is exempted one by one.
      const perUser = await admin
        .put('/v1/settings/auth.requireMfa')
        .send({ scope: 'user', scopeId: `user:${member.id}`, value: false })
        .expect(400);
      expect(perUser.body.errors[0].path).toBe('scope');
      await member.agent
        .put('/v1/settings/auth.requireMfa/mine')
        .send({ value: false })
        .expect(400);
    });

    it("a tenant's requirement: its administrator too, a team's false exempts nobody, API clients are unaffected", async () => {
      const tenant = await node.otherTenant();
      const user = await tenant.user(['editor']);
      const client = await tenant.client();
      const team = await tenant.admin
        .post('/v1/access/teams')
        .send({ name: 'Exempt?' })
        .expect(201);
      await tenant.admin
        .patch(`/v1/access/users/${user.id}`)
        .send({ teamIds: [team.body.id] })
        .expect(204);
      await tenant.admin
        .put('/v1/settings/auth.requireMfa')
        .send({ scope: 'team', scopeId: team.body.id, value: false })
        .expect(200);

      await tenant.admin
        .put('/v1/settings/auth.requireMfa')
        .send({ value: true })
        .expect(200);
      // The administrator who set it is held to it as well…
      await tenant.admin.get('/v1/settings').expect(403);
      // …the team's false doesn't exempt its member…
      await user.agent.get('/v1/test-items').expect(403);
      // …and API clients have no second factor to set up.
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', client.auth)
        .expect(200);
      // The seeded tenant isn't concerned.
      await node.admin().get('/v1/settings').expect(200);

      await enroll(tenant.admin);
      await tenant.admin.get('/v1/settings').expect(200);
      await tenant.admin.delete('/v1/settings/auth.requireMfa').expect(204);
      await user.agent.get('/v1/test-items').expect(200);
    });

    it("the operators' value for every tenant: their true holds everyone, their false (even enforced) exempts nobody", async () => {
      const tenant = await node.otherTenant();
      const user = await tenant.user(['editor']);
      // The operator holds themselves to it too: enrolled first.
      await enroll(node.admin());

      await node
        .admin()
        .put('/v1/settings/auth.requireMfa/platform')
        .send({ value: true })
        .expect(200);
      // The tenant's administrator is held to it as well: to enrollment only.
      await tenant.admin
        .put('/v1/settings/auth.requireMfa')
        .send({ value: false })
        .expect(403);
      await user.agent.get('/v1/test-items').expect(403);

      await node
        .admin()
        .put('/v1/settings/auth.requireMfa/platform')
        .send({ value: false, enforced: true })
        .expect(200);
      await user.agent.get('/v1/test-items').expect(200);
      await tenant.admin
        .put('/v1/settings/auth.requireMfa')
        .send({ value: true })
        .expect(200);
      await user.agent.get('/v1/test-items').expect(403);
    });

    it('AUTH_MFA=off is the ceiling: refused when set, no effect when stored', async () => {
      const member = await node.user(['editor']);
      const team = await teamWith(member.id);
      const admin = node.admin();
      await admin
        .put('/v1/settings/auth.requireMfa')
        .send({ scope: 'team', scopeId: team, value: true })
        .expect(200);
      await member.agent.get('/v1/test-items').expect(403);

      off = ['AUTH_MFA'];
      // Nobody could enroll: the stored requirement holds nobody back…
      await member.agent.get('/v1/test-items').expect(200);
      // …and a new one is refused, saying why.
      const refused = await admin
        .put('/v1/settings/auth.requireMfa')
        .send({ value: true })
        .expect(400);
      expect(refused.body).toMatchObject({ code: 'setting_not_allowed' });
      expect(refused.body.detail).toContain('AUTH_MFA');
      // Turning it off is always allowed.
      await admin
        .put('/v1/settings/auth.requireMfa')
        .send({ scope: 'team', scopeId: team, value: false })
        .expect(200);
    });
  });

  describe('auth.passwordMinLength', () => {
    afterEach(async () => {
      await node.admin().delete('/v1/settings/auth.passwordMinLength');
    });

    it('applies to a change, a reset and an invitation of the tenant; bounded by the floor and the limit', async () => {
      const admin = node.admin();
      const user = await node.user(['editor']);
      for (const value of [8, 65, 'long']) {
        await admin
          .put('/v1/settings/auth.passwordMinLength')
          .send({ value })
          .expect(400);
      }
      await admin
        .put('/v1/settings/auth.passwordMinLength')
        .send({ value: 20 })
        .expect(200);

      // A change.
      const short = await user.agent
        .post('/v1/auth/password/change')
        .send({ currentPassword: user.password, newPassword: newPassword() })
        .expect(400);
      expect(short.body).toMatchObject({
        code: 'password_too_short',
        minLength: 20,
      });
      expect(short.body.errors[0].path).toBe('newPassword');
      const changed = longPassword(20);
      await user.agent
        .post('/v1/auth/password/change')
        .send({ currentPassword: user.password, newPassword: changed })
        .expect(204);

      // A reset: refused before the link is spent, which then still works.
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
      const refused = await node
        .http()
        .post('/v1/auth/password/reset')
        .send({ token, password: newPassword() })
        .expect(400);
      expect(refused.body).toMatchObject({ code: 'password_too_short' });
      const reset = longPassword(24);
      await node
        .http()
        .post('/v1/auth/password/reset')
        .send({ token, password: reset })
        .expect(204);
      await node.signIn(user.email, reset);

      // An invitation's new address chooses a long enough one.
      const email = `${randomBytes(4).toString('hex')}@example.com`;
      const invitation = await node.invite(admin, { email });
      await node
        .http()
        .post('/v1/auth/invitations/accept')
        .send({ token: invitation, password: newPassword() })
        .expect(400)
        .expect((res) => expect(res.body.code).toBe('password_too_short'));
      await node
        .http()
        .post('/v1/auth/invitations/accept')
        .send({ token: invitation, password: longPassword(20) })
        .expect(200);
    });

    it("is the tenant's alone: another tenant's members keep the floor", async () => {
      const tenant = await node.otherTenant();
      const user = await tenant.user(['editor']);
      await node
        .admin()
        .put('/v1/settings/auth.passwordMinLength')
        .send({ value: 30 })
        .expect(200);
      await user.agent
        .post('/v1/auth/password/change')
        .send({ currentPassword: user.password, newPassword: newPassword() })
        .expect(204);
    });
  });
});
