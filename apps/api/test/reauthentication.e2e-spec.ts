import { randomInt, randomUUID } from 'node:crypto';
import { TokenService } from '@nestjs/authentication';
import { Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { OidcAccounts } from '../src/iam/account/account.handlers.js';
import { ReauthenticationService } from '../src/iam/account/reauthentication.service.js';
import { DrizzleAuthenticationStore } from '../src/iam/auth/drizzle-authentication.store.js';
import { tokenClaims } from '../src/iam/auth/authentication-method.js';
import { type Principal, systemPrincipal } from '../src/iam/auth/principal.js';
import {
  SignInContext,
  signInMetadata,
} from '../src/iam/auth/sign-in-context.js';
import {
  memberships,
  sessions,
  userIdentities,
  users,
} from '../src/iam/iam.tables.js';
import { bootApp, newPassword, totp, type TestApp } from './support.js';

/** The token in an email's link. */
const tokenOf = (mail: { link: (match?: string) => URL }, path: string) =>
  mail.link(path).searchParams.get('token')!;

/** An address of its own (trusted proxy: X-Forwarded-For), so per-IP limits don't add up across steps. */
const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

const MINUTE = 60_000;

interface Person {
  id: string;
  email: string;
  password: string;
  agent: request.Agent;
  /** Unused recovery codes, while two-factor is on. */
  recoveryCodes?: string[];
}

interface Context {
  me: Person;
  /** Someone `me` acts on (impersonation, an administrator's change). */
  other: Person;
  clientId?: string;
}

describe('step-up: session auth method and re-authentication (e2e)', () => {
  let node: TestApp;
  const db = () => node.db;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  /** A browser signed in with a password. */
  async function signIn(email: string, password: string) {
    const agent = request.agent(node.app.getHttpServer());
    await agent
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', ip())
      .send({ email, password })
      .expect(200);
    return agent;
  }

  /** A user with these roles who accepted the invitation (their own password), signed in. */
  async function person(roleKeys: string[] = ['editor']): Promise<Person> {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const token = await node.invite(node.admin(), {
      email,
      roleIds: await node.roleIds(...roleKeys),
    });
    const password = await node.acceptAsNew(token, email);
    const agent = await signIn(email, password);
    const me = await agent.get('/v1/auth/me').expect(200);
    return { id: me.body.user.id, email, password, agent };
  }

  const current = async (agent: request.Agent) =>
    (
      (await agent.get('/v1/auth/sessions').expect(200)).body.items as {
        id: string;
        current: boolean;
        method: string | null;
        provider: string | null;
        mfa: boolean;
        authenticatedAt: string | null;
      }[]
    ).find((item) => item.current)!;

  /** Moves the browser's last authentication `minutes` back. */
  async function age(agent: request.Agent, minutes = 11) {
    const { id } = await current(agent);
    await db()
      .update(sessions)
      .set({
        metadata: sql`${sessions.metadata} || ${JSON.stringify({
          authenticatedAt: new Date(
            Date.now() - minutes * MINUTE,
          ).toISOString(),
        })}::jsonb`,
      })
      .where(eq(sessions.id, id));
  }

  /** Two-factor on (the session counts as verified); the recovery codes are kept. */
  async function enableMfa(who: Person) {
    const { secret } = (await who.agent.post('/v1/auth/mfa/enroll').expect(200))
      .body;
    who.recoveryCodes = (
      await who.agent
        .post('/v1/auth/mfa/confirm')
        .send({ code: totp(secret) })
        .expect(200)
    ).body.recoveryCodes;
  }

  /** Re-authenticates in place: the password, and a recovery code while two-factor is on. */
  const reauthenticate = (who: Person) =>
    who.agent
      .post('/v1/auth/reauthenticate')
      .set('X-Forwarded-For', ip())
      .send({
        password: who.password,
        ...(who.recoveryCodes && { recoveryCode: who.recoveryCodes.pop() }),
      });

  // Every tenant's entries and the account's own (a sign-in's, in no tenant).
  const audit = async (action: string, actor: string) =>
    (await node.auditEntries({ action, actor: `user:${actor}` })) as {
      details: Record<string, unknown> | null;
    }[];

  interface Case {
    name: string;
    /** `me` holds the administrator role. */
    admin?: boolean;
    /** Brings the state the action needs; runs before each attempt. */
    prepare?: (c: Context) => Promise<void>;
    act: (c: Context) => Promise<request.Response>;
    ok: number;
  }

  const cases: Case[] = [
    {
      name: 'change the password',
      act: async ({ me }) => {
        const next = newPassword();
        const res = await me.agent
          .post('/v1/auth/password/change')
          .send({ currentPassword: me.password, newPassword: next });
        if (res.status === 204) {
          me.password = next;
        }
        return res;
      },
      ok: 204,
    },
    {
      name: 'set up two-factor',
      act: ({ me }) => me.agent.post('/v1/auth/mfa/enroll'),
      ok: 200,
    },
    {
      name: 'make new recovery codes',
      prepare: async (c) => {
        if (!c.me.recoveryCodes) {
          await enableMfa(c.me);
        }
      },
      act: async ({ me }) => {
        const res = await me.agent.post('/v1/auth/mfa/recovery-codes');
        if (res.status === 200) {
          me.recoveryCodes = res.body.recoveryCodes;
        }
        return res;
      },
      ok: 200,
    },
    {
      name: 'turn two-factor off',
      prepare: async (c) => {
        if (!c.me.recoveryCodes) {
          await enableMfa(c.me);
        }
      },
      act: async ({ me }) => {
        const res = await me.agent.delete('/v1/auth/mfa');
        if (res.status === 204) {
          me.recoveryCodes = undefined;
        }
        return res;
      },
      ok: 204,
    },
    {
      name: 'disconnect a provider',
      prepare: async ({ me }) => {
        await db()
          .insert(userIdentities)
          .values({ provider: 'google', subject: me.id, userId: me.id })
          .onConflictDoNothing();
      },
      act: ({ me }) => me.agent.delete('/v1/auth/identities/google'),
      ok: 204,
    },
    {
      name: 'delete the account',
      act: ({ me }) =>
        me.agent.post('/v1/account/deletion').send({ password: me.password }),
      ok: 200,
    },
    {
      name: 'create an API client',
      admin: true,
      act: ({ me }) =>
        me.agent
          .post('/v1/access/clients')
          .send({ name: `client-${randomUUID().slice(0, 8)}` }),
      ok: 201,
    },
    {
      name: "rotate an API client's key",
      admin: true,
      prepare: async (c) => {
        c.clientId ??= (
          await c.me.agent
            .post('/v1/access/clients')
            .send({ name: `client-${randomUUID().slice(0, 8)}` })
            .expect(201)
        ).body.id;
      },
      act: (c) =>
        c.me.agent.post(`/v1/access/clients/${c.clientId}/rotate`).send({}),
      ok: 200,
    },
    {
      name: 'invite a user with roles',
      admin: true,
      act: async ({ me }) => {
        const email = `${randomUUID().slice(0, 8)}@example.com`;
        return me.agent
          .post('/v1/access/users')
          .send({ email, name: email, roleIds: await node.roleIds('viewer') });
      },
      ok: 202,
    },
    {
      name: "change another user's roles",
      admin: true,
      act: async ({ me, other }) =>
        me.agent
          .patch(`/v1/access/users/${other.id}`)
          .send({ roleIds: await node.roleIds('viewer') }),
      ok: 204,
    },
    {
      name: 'reactivate a user',
      admin: true,
      prepare: async ({ me, other }) => {
        await me.agent
          .patch(`/v1/access/users/${other.id}`)
          .send({ active: false })
          .expect(204);
      },
      act: ({ me, other }) =>
        me.agent.patch(`/v1/access/users/${other.id}`).send({ active: true }),
      ok: 204,
    },
    {
      name: "change an API client's roles",
      admin: true,
      prepare: async (c) => {
        c.clientId ??= (
          await c.me.agent
            .post('/v1/access/clients')
            .send({ name: `client-${randomUUID().slice(0, 8)}` })
            .expect(201)
        ).body.id;
      },
      act: async (c) =>
        c.me.agent
          .patch(`/v1/access/clients/${c.clientId}`)
          .send({ roleIds: await node.roleIds('viewer') }),
      ok: 200,
    },
    {
      name: 'reactivate an API client',
      admin: true,
      prepare: async (c) => {
        c.clientId ??= (
          await c.me.agent
            .post('/v1/access/clients')
            .send({ name: `client-${randomUUID().slice(0, 8)}` })
            .expect(201)
        ).body.id;
        await c.me.agent
          .patch(`/v1/access/clients/${c.clientId}`)
          .send({ active: false })
          .expect(200);
      },
      act: (c) =>
        c.me.agent
          .patch(`/v1/access/clients/${c.clientId}`)
          .send({ active: true }),
      ok: 200,
    },
    {
      name: 'start impersonating',
      admin: true,
      act: async ({ me, other }) => {
        const res = await me.agent.post(
          `/v1/access/users/${other.id}/impersonate`,
        );
        if (res.status === 204) {
          await me.agent.post('/v1/auth/impersonation/stop').expect(204);
        }
        return res;
      },
      ok: 204,
    },
  ];

  it.each(cases)(
    'wants a recent sign-in to $name',
    async ({ admin, prepare, act, ok }) => {
      const c: Context = {
        me: await person(admin ? ['administrator'] : ['editor']),
        other: await person(),
      };
      await prepare?.(c);
      // Signed in a moment ago: through.
      expect((await act(c)).status).toBe(ok);

      await prepare?.(c);
      await age(c.me.agent);
      const stale = await act(c);
      expect(stale.status).toBe(403);
      expect(stale.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(stale.body).toMatchObject({
        code: 'reauthentication_required',
        maxAge: 600,
        // An invitation's link proved the address: email links work too.
        methods: ['password', 'magic-link'],
        mfaRequired: !!c.me.recoveryCodes,
      });
      expect(
        Date.now() - Date.parse(stale.body.authenticatedAt),
      ).toBeGreaterThan(10 * MINUTE);

      await reauthenticate(c.me).expect(200);
      expect((await act(c)).status).toBe(ok);
    },
  );

  // The guard behind @RecentAuthentication() runs after the global ones
  // (PrincipalGuard, then AuthorizationGuard): the permission check sees the
  // signed-in principal (403, where a guest would get 401) and comes first.
  it('checks the permission first, as the signed-in user, on every admin route that wants a recent sign-in', async () => {
    const editor = await person(['editor']);
    const other = await person();
    const clientId = (
      await node
        .admin()
        .post('/v1/access/clients')
        .send({ name: `client-${randomUUID().slice(0, 8)}` })
        .expect(201)
    ).body.id as string;
    const viewer = await node.roleIds('viewer');
    const calls: ((agent: request.Agent) => request.Test)[] = [
      (agent) =>
        agent.post('/v1/access/users').send({
          email: `${randomUUID().slice(0, 8)}@example.com`,
          roleIds: viewer,
        }),
      (agent) =>
        agent.patch(`/v1/access/users/${other.id}`).send({ roleIds: viewer }),
      (agent) => agent.post(`/v1/access/users/${other.id}/impersonate`),
      (agent) =>
        agent
          .post('/v1/access/clients')
          .send({ name: `client-${randomUUID().slice(0, 8)}` }),
      (agent) => agent.post(`/v1/access/clients/${clientId}/rotate`).send({}),
      (agent) =>
        agent.patch(`/v1/access/clients/${clientId}`).send({ roleIds: viewer }),
    ];
    const guest = request.agent(node.app.getHttpServer());
    for (const call of calls) {
      // Signed in a moment ago, without the permission: forbidden.
      const recent = await call(editor.agent);
      expect(recent.status).toBe(403);
      expect(recent.body.code).not.toBe('reauthentication_required');
      // Nobody signed in: authentication refuses before anything else.
      expect((await call(guest)).status).toBe(401);
    }
    // A stale sign-in without the permission: still the permission's 403,
    // never the step-up's (which would tell how to re-authenticate).
    await age(editor.agent);
    for (const call of calls) {
      const stale = await call(editor.agent);
      expect(stale.status).toBe(403);
      expect(stale.body.code).not.toBe('reauthentication_required');
    }
  });

  it("boots without @nestjs/authorization's guard-order error", async () => {
    const errors = vi.spyOn(Logger.prototype, 'error');
    const other = await bootApp();
    try {
      const logged = errors.mock.calls.map((args) => String(args[0]));
      expect(logged.filter((line) => line.includes('runs before'))).toEqual([]);
    } finally {
      errors.mockRestore();
      await other.close();
    }
  });

  it('leaves alone a change of name, a deactivation, an invitation without roles, a quota, and a sign-in with a provider', async () => {
    const me = await person(['administrator']);
    const other = await person();
    const client = (
      await me.agent
        .post('/v1/access/clients')
        .send({ name: `client-${randomUUID().slice(0, 8)}` })
        .expect(201)
    ).body.id;
    await age(me.agent);
    await me.agent
      .patch(`/v1/access/users/${other.id}`)
      .send({ active: false })
      .expect(204);
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    await me.agent
      .post('/v1/access/users')
      .send({ email, name: email, roleIds: [] })
      .expect(202);
    await me.agent
      .patch(`/v1/access/clients/${client}`)
      .send({ dailyQuota: 100, active: false })
      .expect(200);
    await me.agent.get('/v1/auth/oidc/google/login').expect(404);
  });

  it('sends a browser linking a provider from a stale session back to the web app', async () => {
    const me = await person();
    // No provider is configured here: past the checks, the route's 404.
    await me.agent.get('/v1/auth/oidc/google/login?link=true').expect(404);
    await node.http().get('/v1/auth/oidc/google/login?link=true').expect(401);
    await age(me.agent);
    const stale = await me.agent
      .get('/v1/auth/oidc/google/login?link=true&redirectTo=/settings/security')
      .expect(302);
    expect(stale.headers.location).toBe(
      'https://web.example.com/settings/security?error=reauthentication_required',
    );
    // A path that leaves the web app, by any spelling a URL parser accepts, is not followed.
    for (const redirectTo of [
      '//evil.example',
      '/\\evil.example',
      '/%5Cevil.example',
      '/%09/evil.example',
      '/%0A/evil.example',
      'https://evil.example',
      '/%5C%5Cevil.example',
    ]) {
      const elsewhere = await me.agent
        .get(
          `/v1/auth/oidc/google/login?link=true&redirectTo=${redirectTo.replaceAll('\\', '%5C')}`,
        )
        .expect(302);
      expect(elsewhere.headers.location, redirectTo).toBe(
        'https://web.example.com/?error=reauthentication_required',
      );
    }
    // A path of the web app keeps its query and fragment.
    const kept = await me.agent
      .get('/v1/auth/oidc/google/login?link=true&redirectTo=/a%3Fx%3D1%23h')
      .expect(302);
    expect(kept.headers.location).toBe(
      'https://web.example.com/a?x=1&error=reauthentication_required#h',
    );
    await reauthenticate(me).expect(200);
    await me.agent.get('/v1/auth/oidc/google/login?link=true').expect(404);
  });

  it('refuses nobody, and any principal that is neither a user nor an API client', async () => {
    const stepUp = node.app.get(ReauthenticationService);
    await expect(stepUp.assertRecent(null, undefined)).rejects.toMatchObject({
      status: 401,
    });
    const client = await node.client();
    await expect(
      stepUp.assertRecent(
        { kind: 'client', id: client.id, name: 'c', tenantId: node.tenantId },
        { id: client.id },
      ),
    ).resolves.toBeUndefined();
    // The system (a job) never reaches a route; were it to, nothing to prove with.
    await expect(
      stepUp.assertRecent(
        systemPrincipal({ key: 'worker', label: 'Worker' }),
        undefined,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('lets a route ask for a shorter window than the default', async () => {
    const me = await person();
    await age(me.agent, 5);
    const record = await node.app
      .get(DrizzleAuthenticationStore)
      .getSession((await current(me.agent)).id);
    const user = (await me.agent.get('/v1/auth/me').expect(200)).body
      .user as Principal;
    const stepUp = node.app.get(ReauthenticationService);
    await expect(stepUp.assertRecent(user, record)).resolves.toBeUndefined();
    await expect(stepUp.assertRecent(user, record, 3)).rejects.toMatchObject({
      status: 403,
      response: { code: 'reauthentication_required', maxAge: 180 },
    });
  });

  describe('the method each sign-in records', () => {
    it('a password: in the sessions list and GET /auth/me', async () => {
      const me = await person();
      const session = await current(me.agent);
      expect(session).toMatchObject({
        method: 'password',
        provider: null,
        mfa: false,
      });
      expect(Date.now() - Date.parse(session.authenticatedAt!)).toBeLessThan(
        MINUTE,
      );
      const { authentication } = (await me.agent.get('/v1/auth/me').expect(200))
        .body;
      expect(authentication).toEqual({
        via: 'session',
        method: 'password',
        provider: null,
        mfa: false,
        authenticatedAt: session.authenticatedAt,
        recentUntil: new Date(
          Date.parse(session.authenticatedAt!) + 10 * MINUTE,
        ).toISOString(),
      });
    });

    it('a password with two-factor: mfa, and the time the second factor completed', async () => {
      const me = await person();
      await enableMfa(me);
      const browser = request.agent(node.app.getHttpServer());
      await browser
        .post('/v1/auth/sign-in')
        .send({ email: me.email, password: me.password })
        .expect(200);
      // The code comes 11 minutes after the password (the pending session says so).
      await db()
        .update(sessions)
        .set({
          metadata: sql`${sessions.metadata} || ${JSON.stringify({
            authenticatedAt: new Date(Date.now() - 11 * MINUTE).toISOString(),
          })}::jsonb`,
        })
        .where(and(eq(sessions.userId, me.id), eq(sessions.mfa, 'pending')));
      await browser
        .post('/v1/auth/mfa/verify')
        .send({ recoveryCode: me.recoveryCodes!.pop() })
        .expect(200);
      const session = await current(browser);
      expect(session).toMatchObject({ method: 'password', mfa: true });
      expect(Date.now() - Date.parse(session.authenticatedAt!)).toBeLessThan(
        MINUTE,
      );
      // Signed in just now: through.
      await browser.post('/v1/auth/mfa/recovery-codes').expect(200);
    });

    it('an email link', async () => {
      const me = await person();
      await db()
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, me.id));
      const browser = request.agent(node.app.getHttpServer());
      await browser
        .post('/v1/auth/magic-link')
        .send({ email: me.email })
        .expect(202);
      const mail = await node.waitForMail({
        to: me.email,
        subject: 'Your sign-in link',
      });
      await browser
        .post('/v1/auth/magic-link/verify')
        .send({ token: tokenOf(mail, '/magic-link') })
        .expect(200);
      const session = await current(browser);
      expect(session).toMatchObject({ method: 'magic-link', provider: null });
      expect(Date.now() - Date.parse(session.authenticatedAt!)).toBeLessThan(
        MINUTE,
      );
    });

    it("a provider: the method, and the ID token's auth_time when the provider sends one", async () => {
      // OidcService.finish() resolves the account (OidcAccounts) and signs in
      // with `oidc:<provider>` and no metadata of ours, inside the package; the
      // route runs it in the sign-in context, which the session's metadata
      // hook reads (there is no provider to run the real callback against here).
      const me = await person();
      await db()
        .insert(userIdentities)
        .values({ provider: 'google', subject: `g-${me.id}`, userId: me.id });
      const context = node.app.get(SignInContext);
      const cls = node.app.get(ClsService);
      const resolver = node.app.get(OidcAccounts);
      const authTime = Math.floor((Date.now() - 20 * MINUTE) / 1000);
      const profile = (claims: Record<string, unknown>) => ({
        provider: 'google',
        subject: `g-${me.id}`,
        emailVerified: true,
        claims,
      });
      const tokens = { accessToken: 'at' };
      const recorded = await context.run('oidc:google', async () => {
        expect(
          await resolver.resolveUser(
            profile({ auth_time: authTime }),
            tokens,
            {},
          ),
        ).toEqual({ id: me.id });
        return signInMetadata(cls);
      });
      expect(recorded).toEqual({
        method: 'oidc',
        provider: 'google',
        authenticatedAt: new Date(authTime * 1000).toISOString(),
      });
      // Without the claim (GitHub, OAuth 2.0): now.
      const now = await context.run('oidc:github', async () => {
        await resolver.resolveUser(profile({ id: 1 }), tokens, {});
        return signInMetadata(cls);
      });
      expect(now).toMatchObject({ method: 'oidc', provider: 'github' });
      expect(Date.now() - Date.parse(now.authenticatedAt!)).toBeLessThan(
        MINUTE,
      );
      // Nothing leaks out of the sign-in.
      expect(signInMetadata(cls)).not.toHaveProperty('method');
    });

    it('a token client: amr and auth_time', async () => {
      const me = await person();
      const { accessToken } = (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: me.email, password: me.password })
          .expect(200)
      ).body;
      const { authentication } = (
        await node
          .http()
          .get('/v1/auth/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200)
      ).body;
      expect(authentication).toMatchObject({
        via: 'token',
        method: 'password',
        mfa: false,
      });
      expect(
        Date.now() - Date.parse(authentication.authenticatedAt),
      ).toBeLessThan(MINUTE);
    });
  });

  describe('POST /auth/reauthenticate', () => {
    it('checks the password, audits both outcomes, and rotates the session', async () => {
      const me = await person();
      await age(me.agent);
      const status = (await me.agent.get('/v1/auth/reauthenticate').expect(200))
        .body;
      expect(status).toMatchObject({
        methods: ['password', 'magic-link'],
        mfaRequired: false,
        maxAge: 600,
      });
      expect(Date.parse(status.recentUntil)).toBeLessThan(Date.now());

      const missing = await me.agent
        .post('/v1/auth/reauthenticate')
        .send({})
        .expect(400);
      expect(missing.body.errors).toEqual([
        { path: 'password', message: 'Required' },
      ]);
      const wrong = await me.agent
        .post('/v1/auth/reauthenticate')
        .send({ password: newPassword() })
        .expect(403);
      expect(wrong.body.code).toBe('reauthentication_failed');

      const before = await current(me.agent);
      const done = await me.agent
        .post('/v1/auth/reauthenticate')
        .send({ password: me.password })
        .expect(200);
      expect(Date.now() - Date.parse(done.body.authenticatedAt)).toBeLessThan(
        MINUTE,
      );
      expect(done.body.tokens).toBeUndefined();
      const after = await current(me.agent);
      expect(after.id).not.toBe(before.id);
      expect(after).toMatchObject({
        method: 'password',
        authenticatedAt: done.body.authenticatedAt,
      });

      expect(await audit('auth.reauthentication-failed', me.id)).toMatchObject([
        { details: { reason: 'password' } },
      ]);
      expect(await audit('auth.reauthenticated', me.id)).toMatchObject([
        { details: { method: 'password', mfa: false } },
      ]);
    });

    it('wants the code too while two-factor is on; a wrong one is refused', async () => {
      const me = await person();
      await enableMfa(me);
      await age(me.agent);
      const status = (await me.agent.get('/v1/auth/reauthenticate').expect(200))
        .body;
      expect(status).toMatchObject({
        methods: ['password', 'magic-link'],
        mfaRequired: true,
      });
      const noCode = await me.agent
        .post('/v1/auth/reauthenticate')
        .send({ password: me.password })
        .expect(400);
      expect(noCode.body.errors).toEqual([
        { path: 'code', message: 'Required' },
      ]);
      const wrongCode = await me.agent
        .post('/v1/auth/reauthenticate')
        .send({ password: me.password, code: '000000' })
        .expect(403);
      expect(wrongCode.body.code).toBe('reauthentication_failed');
      await reauthenticate(me).expect(200);
      expect(await audit('auth.reauthenticated', me.id)).toMatchObject([
        { details: { method: 'password', mfa: true, recoveryCode: true } },
      ]);
      await me.agent.delete('/v1/auth/mfa').expect(204);
    });

    it('is rate-limited like signing in: 5 tries in 15 minutes from an address', async () => {
      const me = await person();
      for (let attempt = 0; attempt < 5; attempt++) {
        await me.agent
          .post('/v1/auth/reauthenticate')
          .set('X-Forwarded-For', '10.9.9.9')
          .send({ password: newPassword() })
          .expect(403);
      }
      const limited = await me.agent
        .post('/v1/auth/reauthenticate')
        .set('X-Forwarded-For', '10.9.9.9')
        .send({ password: me.password })
        .expect(429);
      expect(limited.body.code).toBe('rate_limited');
    });

    it('is limited per account too: 10 tries in 15 minutes from anywhere', async () => {
      const me = await person();
      for (let attempt = 0; attempt < 10; attempt++) {
        await me.agent
          .post('/v1/auth/reauthenticate')
          .set('X-Forwarded-For', ip())
          .send({ password: newPassword() })
          .expect(403);
      }
      const limited = await me.agent
        .post('/v1/auth/reauthenticate')
        .set('X-Forwarded-For', ip())
        .send({ password: me.password })
        .expect(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after-user']).toBeDefined();
      // Someone else is not held back by it.
      await reauthenticate(await person()).expect(200);
    });

    it('gives a token client new tokens that carry the new time, and revokes the family it sends', async () => {
      const me = await person(['administrator']);
      // A token family from a sign-in an hour ago.
      const stale = await node.app.get(TokenService).issue(me.id, {
        claims: tokenClaims(
          ['pwd'],
          new Date(Date.now() - 60 * MINUTE),
          node.tenantId,
        ),
      });
      const createClient = (accessToken: string) =>
        node
          .http()
          .post('/v1/access/clients')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: `client-${randomUUID().slice(0, 8)}` });
      const refused = await createClient(stale.accessToken).expect(403);
      expect(refused.body.code).toBe('reauthentication_required');

      const done = await node
        .http()
        .post('/v1/auth/reauthenticate')
        .set('Authorization', `Bearer ${stale.accessToken}`)
        .send({ password: me.password, refreshToken: stale.refreshToken })
        .expect(200);
      expect(done.body.tokens).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
      // The old access token keeps its time until it expires; its family is gone.
      await createClient(stale.accessToken).expect(403);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: stale.refreshToken })
        .expect(401);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: done.body.tokens.refreshToken })
        .expect(200);
      await createClient(done.body.tokens.accessToken).expect(201);
      expect(await audit('auth.reauthenticated', me.id)).toMatchObject([
        { details: { method: 'password', via: 'token' } },
      ]);
    });
  });

  describe('an account without a password', () => {
    /**
     * An account without a password (one that signs in by link or with a
     * provider; made here directly, as an invitation's acceptance always
     * sets one), its address verified, a member of the seeded tenant,
     * signed in by email link.
     */
    async function passwordless() {
      const email = `${randomUUID().slice(0, 8)}@example.com`;
      const [created] = await db()
        .insert(users)
        .values({ email, name: email, emailVerified: true })
        .returning({ id: users.id });
      await db()
        .insert(memberships)
        .values({ tenantId: node.tenantId, userId: created!.id });
      const agent = request.agent(node.app.getHttpServer());
      let links = 0;
      const viaLink = async () => {
        await agent
          .post('/v1/auth/magic-link')
          .set('X-Forwarded-For', ip())
          .send({ email })
          .expect(202);
        links += 1;
        // The newest link, once the mail queue sent it.
        const query = { to: email, subject: 'Your sign-in link' };
        for (let tries = 0; tries < 100; tries++) {
          if (node.mailbox.filter(query).length >= links) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const mail = node.mailbox.filter(query).at(-1)!;
        await agent
          .post('/v1/auth/magic-link/verify')
          .send({ token: tokenOf(mail, '/magic-link') })
          .expect(200);
      };
      await viaLink();
      return { id: created!.id, email, agent, viaLink };
    }

    it('re-authenticates by signing in again with a link', async () => {
      const me = await passwordless();
      await age(me.agent);
      const stale = await me.agent.post('/v1/auth/mfa/enroll').expect(403);
      expect(stale.body).toMatchObject({
        code: 'reauthentication_required',
        methods: ['magic-link'],
        mfaRequired: false,
      });
      const unavailable = await me.agent
        .post('/v1/auth/reauthenticate')
        .send({})
        .expect(409);
      expect(unavailable.body).toMatchObject({
        code: 'reauthentication_unavailable',
        methods: ['magic-link'],
      });
      await me.viaLink();
      await me.agent.post('/v1/auth/mfa/enroll').expect(200);
    });

    it('with two-factor on, re-authenticates with a code alone', async () => {
      const me = await passwordless();
      const { secret } = (
        await me.agent.post('/v1/auth/mfa/enroll').expect(200)
      ).body;
      const { recoveryCodes } = (
        await me.agent
          .post('/v1/auth/mfa/confirm')
          .send({ code: totp(secret) })
          .expect(200)
      ).body;
      await age(me.agent);
      const stale = await me.agent.delete('/v1/auth/mfa').expect(403);
      expect(stale.body).toMatchObject({
        methods: ['totp', 'magic-link'],
        mfaRequired: true,
      });
      await me.agent
        .post('/v1/auth/reauthenticate')
        .send({ recoveryCode: recoveryCodes[0] })
        .expect(200);
      expect(await audit('auth.reauthenticated', me.id)).toMatchObject([
        { details: { method: 'totp', mfa: true } },
      ]);
      await me.agent.delete('/v1/auth/mfa').expect(204);
    });
  });

  it('never lets an impersonation satisfy step-up for the impersonated user, nor re-authenticate', async () => {
    const admin = await person(['administrator']);
    const user = await person();
    await db()
      .insert(userIdentities)
      .values({ provider: 'google', subject: user.id, userId: user.id });
    const own = await current(admin.agent);
    await admin.agent
      .post(`/v1/access/users/${user.id}/impersonate`)
      .expect(204);

    const me = (await admin.agent.get('/v1/auth/me').expect(200)).body;
    expect(me.user.id).toBe(user.id);
    expect(me.authentication).toMatchObject({
      method: 'impersonation',
      authenticatedAt: null,
      recentUntil: null,
    });
    // Even a fresh time on the impersonation's session counts for nothing.
    const impersonating = await current(admin.agent);
    await db()
      .update(sessions)
      .set({
        metadata: sql`${sessions.metadata} || ${JSON.stringify({
          authenticatedAt: new Date().toISOString(),
        })}::jsonb`,
      })
      .where(eq(sessions.id, impersonating.id));
    const refused = await admin.agent
      .delete('/v1/auth/identities/google')
      .expect(403);
    expect(refused.body.code).toBe('forbidden');
    // The step-up itself refuses, whatever the route checks on its own.
    const record = await node.app
      .get(DrizzleAuthenticationStore)
      .getSession(impersonating.id);
    const stepUp = node.app.get(ReauthenticationService);
    await expect(stepUp.assertRecent(me.user, record)).rejects.toMatchObject({
      status: 403,
    });
    // Nor would it count for the user themselves, were they behind it.
    const { impersonator: _, ...asUser } = me.user;
    await expect(stepUp.assertRecent(asUser, record)).rejects.toMatchObject({
      status: 403,
      response: { code: 'reauthentication_required' },
    });
    expect(stepUp.status(record).recentUntil).toBeNull();
    for (const password of [user.password, admin.password]) {
      const res = await admin.agent
        .post('/v1/auth/reauthenticate')
        .set('X-Forwarded-For', ip())
        .send({ password })
        .expect(403);
      expect(res.body.code).toBe('forbidden');
    }
    expect(await audit('auth.reauthentication-failed', user.id)).toMatchObject([
      { details: { reason: 'impersonating' } },
      { details: { reason: 'impersonating' } },
    ]);
    // The user sees it among their sessions, for what it is.
    expect(
      (await user.agent.get('/v1/auth/sessions').expect(200)).body.items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'impersonation' }),
      ]),
    );

    // Back to the administrator's own session: their sign-in's time again.
    await admin.agent.post('/v1/auth/impersonation/stop').expect(204);
    expect(await current(admin.agent)).toMatchObject({
      method: 'password',
      authenticatedAt: own.authenticatedAt,
    });
    await admin.agent
      .post('/v1/access/clients')
      .send({ name: `client-${randomUUID().slice(0, 8)}` })
      .expect(201);
    await user.agent.delete('/v1/auth/identities/google').expect(204);
  });
});
