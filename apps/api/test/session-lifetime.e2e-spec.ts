import { eq, sql } from 'drizzle-orm';
import type request from 'supertest';
import { refreshTokens, sessions } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp } from './support.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The session lifetime policy (docs/auth.md, "Policies"): a tenant's
 * `auth.sessionIdleMinutes` and `auth.sessionMaxHours` under the
 * environment's SESSION_IDLE_MINUTES (120) and SESSION_MAX_HOURS (12);
 * they end browser sessions and token clients' refresh-token families.
 * Time is moved by editing the stored timestamps.
 */
describe('session lifetime (e2e)', () => {
  let node: TestApp;
  const set: string[] = [];

  beforeAll(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    for (const key of set.splice(0)) {
      await node.admin().delete(`/v1/settings/${key}`).expect(204);
    }
  });
  afterAll(async () => {
    await node.close();
  });

  /** A tenant setting, removed after the test. */
  async function choose(key: string, value: number) {
    await node.admin().put(`/v1/settings/${key}`).send({ value }).expect(200);
    set.push(key);
  }

  async function sessionId(agent: request.Agent) {
    const listed = await agent.get('/v1/auth/sessions').expect(200);
    return (listed.body.items as { id: string; current: boolean }[]).find(
      (item) => item.current,
    )!.id;
  }

  /** Moves a session's last activity and sign-in back. */
  async function age(
    agent: request.Agent,
    { idle = 0, signedIn = 0 }: { idle?: number; signedIn?: number },
  ) {
    const id = await sessionId(agent);
    await node.db
      .update(sessions)
      .set({
        lastActiveAt: sql`${sessions.lastActiveAt} - ${idle} * interval '1 millisecond'`,
        createdAt: sql`${sessions.createdAt} - ${signedIn} * interval '1 millisecond'`,
      })
      .where(eq(sessions.id, id));
  }

  describe('browser sessions', () => {
    it('has the deployment limits when the tenant chose none, and says so in /me', async () => {
      const member = await node.user(['editor']);
      const me = await member.agent.get('/v1/auth/me').expect(200);
      expect(me.body.session).toMatchObject({ idleMinutes: 120 });
      const ends = Date.parse(me.body.session.expiresAt) - Date.now();
      expect(ends).toBeGreaterThan(11 * HOUR);
      expect(ends).toBeLessThanOrEqual(12 * HOUR);
      // Just under the environment's idle timeout: still in.
      await age(member.agent, { idle: 119 * MINUTE });
      await member.agent.get('/v1/test-items').expect(200);
    });

    it("ends after the tenant's idle timeout, not before", async () => {
      await choose('auth.sessionIdleMinutes', 10);
      const member = await node.user(['editor']);
      const me = await member.agent.get('/v1/auth/me').expect(200);
      expect(me.body.session.idleMinutes).toBe(10);

      await age(member.agent, { idle: 9 * MINUTE });
      await member.agent.get('/v1/test-items').expect(200);
      // That request was activity: counted from there, not from before.
      await age(member.agent, { idle: 11 * MINUTE });
      await member.agent.get('/v1/test-items').expect(401);
      // Gone for good, even if the policy is lifted.
      await node.admin().delete('/v1/settings/auth.sessionIdleMinutes');
      set.length = 0;
      await member.agent.get('/v1/test-items').expect(401);
    });

    it("ends the tenant's maximum lifetime after the sign-in, however active", async () => {
      await choose('auth.sessionMaxHours', 1);
      const member = await node.user(['editor']);
      const me = await member.agent.get('/v1/auth/me').expect(200);
      const ends = Date.parse(me.body.session.expiresAt) - Date.now();
      expect(ends).toBeGreaterThan(59 * MINUTE);
      expect(ends).toBeLessThanOrEqual(HOUR);

      await age(member.agent, { signedIn: 59 * MINUTE });
      await member.agent.get('/v1/test-items').expect(200);
      await age(member.agent, { signedIn: 2 * MINUTE });
      await member.agent.get('/v1/test-items').expect(401);
    });

    it('ends only the sessions of the tenant that chose', async () => {
      const member = await node.user(['editor']);
      await choose('auth.sessionIdleMinutes', 5);
      const other = await node.otherTenant();
      await age(other.admin, { idle: 30 * MINUTE });
      await other.admin.get('/v1/auth/me').expect(200);
      await age(member.agent, { idle: 6 * MINUTE });
      await member.agent.get('/v1/auth/me').expect(401);
    });

    it("refuses a value over the deployment's ceiling, and one under the floor", async () => {
      const idle = await node
        .admin()
        .put('/v1/settings/auth.sessionIdleMinutes')
        .send({ value: 121 })
        .expect(400);
      expect(idle.body.code).toBe('setting_not_allowed');
      const hours = await node
        .admin()
        .put('/v1/settings/auth.sessionMaxHours')
        .send({ value: 13 })
        .expect(400);
      expect(hours.body.code).toBe('setting_not_allowed');
      await node
        .admin()
        .put('/v1/settings/auth.sessionIdleMinutes')
        .send({ value: 4 })
        .expect(400);
      // The ceiling itself is fine.
      await choose('auth.sessionIdleMinutes', 120);
      await choose('auth.sessionMaxHours', 12);
    });
  });

  describe('token clients', () => {
    async function tokens(member: { email: string; password: string }) {
      return (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: member.email, password: member.password })
          .expect(200)
      ).body as { accessToken: string; refreshToken: string };
    }

    /** Moves the family's tokens back (their sign-in and last refresh). */
    async function ageFamily(userId: string, by: number) {
      await node.db
        .update(refreshTokens)
        .set({
          createdAt: sql`${refreshTokens.createdAt} - ${by} * interval '1 millisecond'`,
        })
        .where(eq(refreshTokens.userId, userId));
    }

    it('keeps its own lifetime when the tenant chose none', async () => {
      const member = await node.user(['editor']);
      const issued = await tokens(member);
      await ageFamily(member.id, 30 * HOUR);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: issued.refreshToken })
        .expect(200);
    });

    it("ends a family at the tenant's maximum lifetime and revokes it", async () => {
      await choose('auth.sessionMaxHours', 1);
      const member = await node.user(['editor']);
      const issued = await tokens(member);
      const refreshed = await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: issued.refreshToken })
        .expect(200);
      await ageFamily(member.id, 2 * HOUR);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: refreshed.body.refreshToken })
        .expect(401);
      // Revoked: not even a later lifting of the policy brings it back.
      await node.admin().delete('/v1/settings/auth.sessionMaxHours');
      set.length = 0;
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: refreshed.body.refreshToken })
        .expect(401);
    });

    it("ends a family idle past the tenant's timeout (and the access token's 15 minutes)", async () => {
      await choose('auth.sessionIdleMinutes', 10);
      const member = await node.user(['editor']);
      const issued = await tokens(member);
      await ageFamily(member.id, 20 * MINUTE);
      const refreshed = await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: issued.refreshToken })
        .expect(200);
      await ageFamily(member.id, 26 * MINUTE);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: refreshed.body.refreshToken })
        .expect(401);
    });
  });
});
