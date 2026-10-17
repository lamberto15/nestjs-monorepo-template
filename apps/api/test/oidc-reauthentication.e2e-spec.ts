import { randomBytes } from 'node:crypto';
import { OidcService } from '@nestjs/authentication';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { Redis } from 'ioredis';
import type request from 'supertest';
import type { Database } from '../src/core/database/drizzle.js';
import { REDIS } from '../src/core/redis/redis.js';
import { ClsService } from 'nestjs-cls';
import { OidcAccounts } from '../src/iam/account/account.handlers.js';
import {
  SignInContext,
  signInMetadata,
} from '../src/iam/auth/sign-in-context.js';
import { userIdentities } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp } from './support.js';

// A configured GitHub (read once, when AppModule loads): an OAuth 2.0
// provider with fixed endpoints, so the login builds its URL without
// discovery, and the tests reach no provider.
vi.hoisted(() => {
  Object.assign(process.env, {
    GITHUB_CLIENT_ID: 'reauthentication-test',
    // Made at runtime (a local hook refuses key-like literals).
    GITHUB_CLIENT_SECRET: Math.random().toString(36).slice(2),
  });
});

const MINUTE = 60_000;

describe('step-up through a provider: prompt=login and auth_time (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await node.close();
  });

  /** A user with GitHub connected, signed in with their password. */
  async function person() {
    // Invited and accepted: a proved address, in the seeded tenant.
    const { id, email, agent } = await node.user([]);
    await node.app
      .get<Database>(getDrizzleToken())
      .insert(userIdentities)
      .values({ provider: 'github', subject: `gh-${id}`, userId: id });
    return { id, email, agent };
  }

  /** Starts a step-up; the provider's URL it answers. */
  async function start(agent: request.Agent, query = '') {
    const res = await agent
      .get(`/v1/auth/oidc/github/login?reauthenticate=true${query}`)
      .expect(302);
    return new URL(res.headers.location!);
  }

  /**
   * The provider's answer, simulated: the package's `finish()` (state
   * cookie, code exchange) can't run without GitHub, so it is replaced by
   * one that hands the real resolver this profile, as `finish()` does.
   */
  function providerAnswers(subject: string, claims: Record<string, unknown>) {
    const resolver = node.app.get(OidcAccounts);
    return vi
      .spyOn(node.app.get(OidcService), 'finish')
      .mockImplementation(async () => {
        const user = await resolver.resolveUser(
          { provider: 'github', subject, emailVerified: true, claims },
          { accessToken: 'at' },
          {},
        );
        if (!user) {
          throw new Error('account not allowed');
        }
        return { url: 'https://web.example.com/settings', cookies: [] };
      });
  }

  /** The user's audit entries of this kind (account-level: no tenant's log shows them). */
  const audit = async (action: string, userId: string) =>
    (await node.auditEntries({ action, actor: `user:${userId}` })) as {
      tenantId: string | null;
      details: Record<string, unknown>;
    }[];

  it('asks the provider for a fresh login, and remembers whose step-up it is', async () => {
    const me = await person();
    const url = await start(me.agent, '&redirectTo=/settings');
    expect(url.origin + url.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    const state = url.searchParams.get('state')!;
    expect(state).toBeTruthy();
    const remembered = JSON.parse(
      (await node.app.get<Redis>(REDIS).get(`oidc:reauthentication:${state}`))!,
    ) as { userId: string; startedAt: number; redirectTo: string };
    expect(remembered).toMatchObject({
      userId: me.id,
      redirectTo: '/settings',
    });
    expect(Date.now() - remembered.startedAt).toBeLessThan(MINUTE);

    // A plain sign-in doesn't ask the provider again.
    const plain = await node
      .http()
      .get('/v1/auth/oidc/github/login')
      .expect(302);
    const plainUrl = new URL(plain.headers.location!);
    expect(plainUrl.searchParams.has('prompt')).toBe(false);
    expect(plainUrl.searchParams.has('max_age')).toBe(false);
  });

  it('is for a signed-in user, one flow at a time, never while impersonating', async () => {
    await node
      .http()
      .get('/v1/auth/oidc/github/login?reauthenticate=true')
      .expect(401);
    const me = await person();
    await me.agent
      .get('/v1/auth/oidc/github/login?reauthenticate=true&link=true')
      .expect(400);
    await me.agent
      .get('/v1/auth/oidc/nobody/login?reauthenticate=true')
      .expect(404);
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    await admin.post(`/v1/access/users/${me.id}/impersonate`).expect(204);
    await admin
      .get('/v1/auth/oidc/github/login?reauthenticate=true')
      .expect(403);
  });

  it('accepts the same user, authenticated after the start, once; audited', async () => {
    const me = await person();
    const state = (await start(me.agent)).searchParams.get('state')!;
    const finish = providerAnswers(`gh-${me.id}`, {
      auth_time: Math.floor(Date.now() / 1000),
    });
    const done = await me.agent
      .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
      .expect(302);
    expect(done.headers.location).toBe('https://web.example.com/settings');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(await audit('auth.reauthenticated', me.id)).toMatchObject([
      { details: { method: 'oidc', provider: 'github' } },
    ]);
    // Taken: the same state again is a plain sign-in, not a second step-up.
    expect(
      await node.app.get<Redis>(REDIS).get(`oidc:reauthentication:${state}`),
    ).toBeNull();
    await me.agent
      .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
      .expect(302);
    expect(await audit('auth.reauthenticated', me.id)).toHaveLength(1);
  });

  it("refuses a provider that didn't ask again (an auth_time before the start), and sends the browser back", async () => {
    const me = await person();
    const state = (
      await start(me.agent, '&redirectTo=/settings/security')
    ).searchParams.get('state')!;
    providerAnswers(`gh-${me.id}`, {
      auth_time: Math.floor((Date.now() - 20 * MINUTE) / 1000),
    });
    const refused = await me.agent
      .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
      .expect(302);
    expect(refused.headers.location).toBe(
      'https://web.example.com/settings/security?error=reauthentication_failed',
    );
    expect(await audit('auth.reauthentication-failed', me.id)).toMatchObject([
      { details: { method: 'oidc', provider: 'github', reason: 'stale' } },
    ]);
    // No sign-in happened: the browser keeps its session.
    await me.agent.get('/v1/auth/me').expect(200);
  });

  it("refuses another account's identity, or one connected to nobody, and creates nothing", async () => {
    const me = await person();
    const other = await person();
    for (const subject of [
      `gh-${other.id}`,
      `gh-new-${randomBytes(4).toString('hex')}`,
    ]) {
      const state = (await start(me.agent)).searchParams.get('state')!;
      providerAnswers(subject, {});
      const refused = await me.agent
        .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
        .expect(302);
      expect(refused.headers.location).toBe(
        'https://web.example.com/?error=reauthentication_failed',
      );
      vi.restoreAllMocks();
    }
    const failures = await audit('auth.reauthentication-failed', me.id);
    expect(failures.map((entry) => entry.details.reason)).toEqual([
      'account',
      'account',
    ]);
    const identities = await node.app
      .get<Database>(getDrizzleToken())
      .select()
      .from(userIdentities);
    expect(
      identities.filter((row) => row.subject.startsWith('gh-new-')),
    ).toHaveLength(0);
  });

  it('accepts a provider without auth_time (OAuth 2.0) as now', async () => {
    const me = await person();
    const state = (await start(me.agent)).searchParams.get('state')!;
    providerAnswers(`gh-${me.id}`, { id: 1 });
    const done = await me.agent
      .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
      .expect(302);
    expect(done.headers.location).toBe('https://web.example.com/settings');
  });

  it('keeps the tenant of the session it re-authenticates, while the person is a member of it', async () => {
    const me = await person();
    const seeded = (await me.agent.get('/v1/auth/me').expect(200)).body.user
      .tenantId as string;
    const elsewhere = (await node.otherTenant()).id;
    const context = node.app.get(SignInContext);
    const cls = node.app.get(ClsService);
    const resolver = node.app.get(OidcAccounts);
    const stepUp = (tenantId: string) =>
      context.run(
        'oidc:github',
        async () => {
          await resolver.resolveUser(
            {
              provider: 'github',
              subject: `gh-${me.id}`,
              emailVerified: true,
              claims: {},
            },
            { accessToken: 'at' },
            {},
          );
          return signInMetadata(cls);
        },
        {
          reauthenticating: {
            userId: me.id,
            startedAt: Date.now(),
            tenantId,
          },
        },
      );
    expect((await stepUp(seeded)).tenantId).toBe(seeded);
    // Not (or no longer) a member there: the session store picks the last
    // chosen tenant, as for any sign-in.
    expect(await stepUp(elsewhere)).not.toHaveProperty('tenantId');
  });

  it("isn't burnt by a callback without this browser's transaction cookie: the real one is still a step-up", async () => {
    const me = await person();
    const state = (await start(me.agent)).searchParams.get('state')!;
    // Someone who learnt the state (a log, a referrer) calls back without
    // the browser's cookies: the package refuses it, the step-up stays.
    await node
      .http()
      .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
      .expect(400);
    expect(
      await node.app.get<Redis>(REDIS).get(`oidc:reauthentication:${state}`),
    ).not.toBeNull();
    // The browser's own callback is still judged as a step-up: a stale
    // login is refused, not let in as a plain sign-in.
    providerAnswers(`gh-${me.id}`, {
      auth_time: Math.floor((Date.now() - 20 * MINUTE) / 1000),
    });
    const refused = await me.agent
      .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
      .expect(302);
    expect(refused.headers.location).toBe(
      'https://web.example.com/?error=reauthentication_failed',
    );
    expect(await audit('auth.reauthentication-failed', me.id)).toMatchObject([
      { details: { reason: 'stale' } },
    ]);
  });

  it('refuses a step-up callback whose step-up is gone, never signing in instead', async () => {
    const me = await person();
    const state = (await start(me.agent)).searchParams.get('state')!;
    await node.app.get<Redis>(REDIS).del(`oidc:reauthentication:${state}`);
    const finish = providerAnswers(`gh-${me.id}`, {});
    const refused = await me.agent
      .get(`/v1/auth/oidc/github/callback?state=${state}&code=c`)
      .expect(302);
    expect(refused.headers.location).toBe(
      'https://web.example.com/?error=reauthentication_failed',
    );
    expect(finish).not.toHaveBeenCalled();
    const [entry] = await node.auditEntries({
      action: 'auth.reauthentication-failed',
    });
    expect(entry).toMatchObject({
      actor: 'anonymous',
      tenantId: null,
      details: { method: 'oidc', provider: 'github', reason: 'expired' },
    });
    // The step-up cookie is cleared; the browser keeps its session.
    expect(String(refused.headers['set-cookie'])).toMatch(
      /oidc_reauth=; .*Max-Age=0/,
    );
    await me.agent.get('/v1/auth/me').expect(200);
  });

  it('refuses an OpenID Connect login without auth_time (its ID token must have one)', async () => {
    const me = await person();
    await node.app
      .get<Database>(getDrizzleToken())
      .insert(userIdentities)
      .values({ provider: 'google', subject: `g-${me.id}`, userId: me.id });
    const context = node.app.get(SignInContext);
    const resolver = node.app.get(OidcAccounts);
    const stepUp = (claims: Record<string, unknown>) =>
      context.run(
        'oidc:google',
        () =>
          resolver.resolveUser(
            {
              provider: 'google',
              subject: `g-${me.id}`,
              emailVerified: true,
              claims,
            },
            { accessToken: 'at', idToken: 'id' },
            {},
          ),
        { reauthenticating: { userId: me.id, startedAt: Date.now() } },
      );
    await expect(stepUp({})).rejects.toMatchObject({ reason: 'stale' });
    await expect(
      stepUp({ auth_time: Math.floor(Date.now() / 1000) }),
    ).resolves.toEqual({ id: me.id });
  });
});
