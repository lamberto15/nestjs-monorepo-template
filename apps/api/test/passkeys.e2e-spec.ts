import { randomInt, randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { Database } from '../src/core/database/drizzle.js';
import { UsersRepository } from '../src/iam/auth/users.repository.js';
import { AccountTransfer } from '../src/platform/account/account.transfer.js';
import {
  auditLog,
  passkeys,
  sessions,
  userIdentities,
  users,
} from '../src/iam/iam.tables.js';
import {
  type SoftwareCredential,
  SoftwareAuthenticator,
} from './software-authenticator.js';
import { bootApp, newPassword, totp, type TestApp } from './support.js';

// Read when AppModule loads: the web app's origin is trusted (CORS and the
// package's login-CSRF check), and native apps are listed for the
// .well-known files. WEB_URL (setup-env.ts) makes the RP ID web.example.com.
const ANDROID_FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).padStart(2, '0').toUpperCase(),
).join(':');
await vi.hoisted(async () => {
  Object.assign(process.env, {
    CORS_ORIGINS: 'https://web.example.com,https://app.web.example.com',
    PASSKEY_ORIGINS: 'https://app.web.example.com',
    PASSKEY_ANDROID_APPS: `com.example.app:${Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':')}`,
    PASSKEY_APPLE_APPS: 'ABCDE12345.com.example.app',
  });
});

const WEB = 'https://web.example.com';
const RP_ID = 'web.example.com';
const MINUTE = 60_000;

/** An address of its own (trusted proxy: X-Forwarded-For), so per-address limits don't add up. */
const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

interface Person {
  id: string;
  email: string;
  password: string;
  agent: request.Agent;
  device: SoftwareAuthenticator;
}

describe('passkeys (e2e)', () => {
  let node: TestApp;
  const db = () => node.app.get<Database>(getDrizzleToken());

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  /** A browser signed in with a password, from the web app's origin. */
  async function signIn(email: string, password: string) {
    const agent = request.agent(node.app.getHttpServer());
    await agent
      .post('/v1/auth/sign-in')
      .set('X-Forwarded-For', ip())
      .set('Origin', WEB)
      .send({ email, password })
      .expect(200);
    return agent;
  }

  /** A user with a password, signed in, with a software authenticator of their own. */
  async function person(options: { synced?: boolean } = {}): Promise<Person> {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const password = newPassword();
    const created = await node
      .admin()
      .post('/v1/access/users')
      .send({ email, name: email, password, roleIds: [] })
      .expect(201);
    return {
      id: created.body.id,
      email,
      password,
      agent: await signIn(email, password),
      device: new SoftwareAuthenticator({ origin: WEB, ...options }),
    };
  }

  /** Registers a passkey from the person's browser: the credential and the API's view of it. */
  async function register(
    who: Person,
    name = 'Laptop',
  ): Promise<{ credential: SoftwareCredential; id: string }> {
    const options = (
      await who.agent
        .post('/v1/auth/passkeys/registration/options')
        .set('Origin', WEB)
        .expect(200)
    ).body;
    const { credential, response } = who.device.create(options);
    const created = await who.agent
      .post('/v1/auth/passkeys')
      .set('Origin', WEB)
      .send({ name, response })
      .expect(201);
    return { credential, id: created.body.id };
  }

  /** The options of a passkey sign-in (usernameless without an email). */
  async function signInOptions(
    body: { email?: string } = {},
    address = ip(),
    /** null: no Origin header (a native app). */
    origin: string | null = WEB,
  ) {
    const req = node
      .http()
      .post('/v1/auth/passkeys/sign-in/options')
      .set('X-Forwarded-For', address);
    if (origin) {
      req.set('Origin', origin);
    }
    return (await req.send(body).expect(200)).body;
  }

  /** Posts an assertion to the browser sign-in from a fresh browser. */
  function passkeySignIn(
    response: unknown,
    agent = request.agent(node.app.getHttpServer()),
    origin = WEB,
  ) {
    return agent
      .post('/v1/auth/passkeys/sign-in')
      .set('X-Forwarded-For', ip())
      .set('Origin', origin)
      .send({ response });
  }

  const current = async (agent: request.Agent) =>
    (
      (await agent.get('/v1/auth/sessions').expect(200)).body.items as {
        id: string;
        current: boolean;
        method: string | null;
        mfa: boolean;
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

  /**
   * Two-factor on; returns the recovery codes (the confirming code's
   * window is spent: a code works once).
   */
  async function enableMfa(who: Person) {
    const { secret } = (await who.agent.post('/v1/auth/mfa/enroll').expect(200))
      .body;
    const confirmed = await who.agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(secret) })
      .expect(200);
    return confirmed.body.recoveryCodes as string[];
  }

  /** The failed passkey sign-ins' reasons, oldest first. */
  const failures = async () =>
    (
      await db()
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'auth.sign-in-failed'),
            sql`${auditLog.details}->>'method' = 'passkey'`,
          ),
        )
        .orderBy(auditLog.id)
    ).map((row) => (row.details as { reason: string }).reason);

  it('registers several named passkeys, lists, renames and removes them, audited and told', async () => {
    const me = await person();
    const laptop = await register(me, 'Laptop');
    const phone = await register(me, 'Phone');
    const listed = (await me.agent.get('/v1/auth/passkeys').expect(200)).body
      .items;
    expect(listed.map((item: { name: string }) => item.name)).toEqual([
      'Laptop',
      'Phone',
    ]);
    expect(listed[0]).toMatchObject({
      id: laptop.id,
      deviceType: 'singleDevice',
      backedUp: false,
      lastUsedAt: null,
    });
    expect(listed[0]).not.toHaveProperty('publicKey');

    const renamed = await me.agent
      .patch(`/v1/auth/passkeys/${phone.id}`)
      .send({ name: 'Pixel' })
      .expect(200);
    expect(renamed.body.name).toBe('Pixel');
    // Another user's passkey is nobody's business: 404.
    const other = await person();
    await other.agent
      .patch(`/v1/auth/passkeys/${phone.id}`)
      .send({ name: 'Mine' })
      .expect(404);
    await other.agent.delete(`/v1/auth/passkeys/${phone.id}`).expect(404);

    await me.agent.delete(`/v1/auth/passkeys/${phone.id}`).expect(204);
    expect(
      (await me.agent.get('/v1/auth/passkeys').expect(200)).body.items,
    ).toHaveLength(1);

    const actions = (
      await db()
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(sql`${auditLog.action} like 'auth.passkey-%'`)
        .orderBy(auditLog.id)
    ).map((row) => row.action);
    expect(actions).toEqual([
      'auth.passkey-added',
      'auth.passkey-added',
      'auth.passkey-renamed',
      'auth.passkey-removed',
    ]);
    await node.app.get(OutboxRelay).runOnce();
    const types = (
      await me.agent.get('/v1/notifications?sort=createdAt').expect(200)
    ).body.items
      .map((item: { type: string }) => item.type)
      .filter((type: string) => type.startsWith('security.passkey'));
    expect(types).toEqual([
      'security.passkeyAdded',
      'security.passkeyAdded',
      'security.passkeyRemoved',
    ]);
  });

  it('registers only from a recent sign-in, with user verification, from the session and origin that asked', async () => {
    const me = await person();
    await age(me.agent);
    const stale = await me.agent
      .post('/v1/auth/passkeys/registration/options')
      .set('Origin', WEB)
      .expect(403);
    expect(stale.body.code).toBe('reauthentication_required');

    const fresh = await person();
    const ask = async () =>
      (
        await fresh.agent
          .post('/v1/auth/passkeys/registration/options')
          .set('Origin', WEB)
          .expect(200)
      ).body;
    const options = await ask();
    expect(options).toMatchObject({
      rp: { id: RP_ID },
      attestation: 'none',
      authenticatorSelection: { userVerification: 'required' },
    });
    // No user verification: never a second factor, so not registered.
    const unverified = await fresh.agent
      .post('/v1/auth/passkeys')
      .set('Origin', WEB)
      .send({
        name: 'Key',
        response: fresh.device.create(options, { uv: false }).response,
      })
      .expect(400);
    expect(unverified.body).toMatchObject({
      code: 'passkey_invalid',
      reason: 'user-verification',
    });
    // The challenge went with it: one-time.
    const replay = await fresh.agent
      .post('/v1/auth/passkeys')
      .set('Origin', WEB)
      .send({ name: 'Key', response: fresh.device.create(options).response })
      .expect(400);
    expect(replay.body.reason).toBe('challenge');

    // Another browser of the same user can't finish this session's ceremony.
    const second = await ask();
    const elsewhere = await signIn(fresh.email, fresh.password);
    const otherSession = await elsewhere
      .post('/v1/auth/passkeys')
      .set('Origin', WEB)
      .send({ name: 'Key', response: fresh.device.create(second).response })
      .expect(400);
    expect(otherSession.body.reason).toBe('session');

    // Nor another origin, whether the page's (Origin) or the browser's (clientDataJSON).
    const third = await ask();
    const otherOrigin = await fresh.agent
      .post('/v1/auth/passkeys')
      .set('Origin', 'https://app.web.example.com')
      .send({ name: 'Key', response: fresh.device.create(third).response })
      .expect(400);
    expect(otherOrigin.body.reason).toBe('origin');
    const fourth = await ask();
    const phished = await fresh.agent
      .post('/v1/auth/passkeys')
      .set('Origin', WEB)
      .send({
        name: 'Key',
        response: fresh.device.create(fourth, {
          origin: 'https://web.example.com.evil.test',
        }).response,
      })
      .expect(400);
    expect(phished.body.reason).toBe('origin');
    expect(
      (await fresh.agent.get('/v1/auth/passkeys').expect(200)).body.items,
    ).toEqual([]);
  });

  it('signs in usernameless and with an email; the session records method passkey', async () => {
    const me = await person();
    await register(me);
    const usernameless = await signInOptions();
    expect(usernameless.allowCredentials).toBeUndefined();
    expect(usernameless).toMatchObject({
      rpId: RP_ID,
      userVerification: 'required',
    });
    const browser = request.agent(node.app.getHttpServer());
    const signedIn = await passkeySignIn(
      me.device.get(usernameless),
      browser,
    ).expect(200);
    expect(signedIn.body).toEqual({ signedIn: true, mfaRequired: false });
    const session = await current(browser);
    expect(session.method).toBe('passkey');
    const meNow = (await browser.get('/v1/auth/me').expect(200)).body;
    expect(meNow.authentication).toMatchObject({
      via: 'session',
      method: 'passkey',
    });

    // With the email: the account's passkeys are listed, and the challenge is the account's.
    const byEmail = await signInOptions({ email: me.email });
    expect(byEmail.allowCredentials).toEqual([
      {
        id: me.device.credentials[0].id,
        type: 'public-key',
        transports: ['internal', 'hybrid'],
      },
    ]);
    await passkeySignIn(me.device.get(byEmail)).expect(200);

    const [row] = await db()
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, me.id));
    expect(row.counter).toBe(2);
    expect(row.lastUsedAt).not.toBeNull();
    const [entry] = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'auth.signed-in'),
          eq(auditLog.actor, `user:${me.id}`),
          sql`${auditLog.details}->>'method' = 'passkey'`,
        ),
      )
      .limit(1);
    expect(entry.details).toMatchObject({
      method: 'passkey',
      passkey: row.id,
      userVerified: true,
    });
  });

  it('answers an email without passkeys, or without an account, like one with them', async () => {
    const me = await person();
    await register(me);
    const unknown = `${randomUUID().slice(0, 8)}@example.com`;
    const noPasskeys = await person();
    const shapes = await Promise.all([
      signInOptions({ email: me.email }),
      signInOptions({ email: unknown }),
      signInOptions({ email: noPasskeys.email }),
    ]);
    for (const options of shapes) {
      expect(Object.keys(options).sort()).toEqual(
        Object.keys(shapes[0]).sort(),
      );
      expect(options.allowCredentials).toHaveLength(1);
      expect(options.allowCredentials[0].id).toMatch(/^[\w-]{22}$/);
    }
    // The decoy is the same every time: a second look tells nothing either.
    const again = await signInOptions({ email: ` ${unknown.toUpperCase()} ` });
    expect(again.allowCredentials).toEqual(shapes[1].allowCredentials);
    expect(shapes[2].allowCredentials).not.toEqual(shapes[1].allowCredentials);
  });

  it('takes each challenge once, for its own ceremony and account', async () => {
    const me = await person();
    await register(me);
    const options = await signInOptions();
    const assertion = me.device.get(options);
    await passkeySignIn(assertion).expect(200);
    // The same answer again: the challenge is gone (GETDEL).
    await passkeySignIn(assertion).expect(401);
    // A challenge nobody issued.
    await passkeySignIn(
      me.device.get(await signInOptions(), { challenge: 'A'.repeat(43) }),
    ).expect(401);
    // A registration's challenge can't finish a sign-in.
    const registration = (
      await me.agent
        .post('/v1/auth/passkeys/registration/options')
        .set('Origin', WEB)
        .expect(200)
    ).body;
    await passkeySignIn(
      me.device.get(await signInOptions(), {
        challenge: registration.challenge,
      }),
    ).expect(401);
    // A challenge made for another account's email.
    const other = await person();
    await register(other);
    const forOther = await signInOptions({ email: other.email });
    await passkeySignIn(
      me.device.get(
        { ...forOther, allowCredentials: undefined },
        { credential: me.device.credentials[0] },
      ),
    ).expect(401);
    expect(await failures()).toEqual([
      'challenge',
      'challenge',
      'challenge',
      'user',
    ]);
  });

  it('refuses another origin: the page’s Origin and the browser’s clientDataJSON', async () => {
    const me = await person();
    await register(me);
    // clientDataJSON from a site that isn't this RP's (a phishing page).
    await passkeySignIn(
      me.device.get(await signInOptions(), {
        origin: 'https://web-example.evil.test',
      }),
    ).expect(401);
    // Options asked from one configured origin, answered from another.
    await passkeySignIn(
      me.device.get(await signInOptions({}, ip(), WEB), {
        origin: 'https://app.web.example.com',
      }),
      undefined,
      'https://app.web.example.com',
    ).expect(401);
    // A page on an origin nobody configured can't even start a ceremony:
    // the app's CSRF check refuses its state-changing request.
    await node
      .http()
      .post('/v1/auth/passkeys/sign-in/options')
      .set('X-Forwarded-For', ip())
      .set('Origin', 'https://web-example.evil.test')
      .send({})
      .expect(403);
    // The second configured origin works on its own.
    const APP = 'https://app.web.example.com';
    const app = new SoftwareAuthenticator({ origin: APP });
    app.credentials.push(...me.device.credentials);
    const options = await signInOptions({}, ip(), APP);
    await passkeySignIn(app.get(options), undefined, APP).expect(200);
    expect((await failures()).slice(0, 2)).toEqual(['origin', 'origin']);
  });

  it('completes two-factor only with user verification', async () => {
    const me = await person();
    await register(me);
    const recoveryCodes = await enableMfa(me);

    const verified = request.agent(node.app.getHttpServer());
    const both = await passkeySignIn(
      me.device.get(await signInOptions()),
      verified,
    ).expect(200);
    expect(both.body).toEqual({ signedIn: true, mfaRequired: false });
    expect(await current(verified)).toMatchObject({
      method: 'passkey',
      mfa: true,
    });
    // The verified session works where two-factor is required.
    await verified.post('/v1/auth/mfa/recovery-codes').expect(200);

    // Presence alone: the first factor; the code still goes to /mfa/verify.
    const present = request.agent(node.app.getHttpServer());
    const first = await passkeySignIn(
      me.device.get(await signInOptions(), { uv: false }),
      present,
    ).expect(200);
    expect(first.body).toEqual({ signedIn: false, mfaRequired: true });
    await present.get('/v1/auth/me').expect(401);
    await present
      .post('/v1/auth/mfa/verify')
      .set('Origin', WEB)
      .send({ recoveryCode: recoveryCodes.pop() })
      .expect(200);
    expect(await current(present)).toMatchObject({
      method: 'passkey',
      mfa: true,
    });
  });

  it('refuses a counter that went backwards; a synced passkey keeps 0', async () => {
    const me = await person();
    const { credential } = await register(me);
    await passkeySignIn(me.device.get(await signInOptions())).expect(200);
    await passkeySignIn(me.device.get(await signInOptions())).expect(200);
    // A clone of the authenticator, copied before its first use.
    credential.counter = 0;
    await passkeySignIn(me.device.get(await signInOptions())).expect(401);
    expect(await failures()).toEqual(['counter']);
    const [row] = await db()
      .select({ counter: passkeys.counter })
      .from(passkeys)
      .where(eq(passkeys.userId, me.id));
    expect(row.counter).toBe(2);

    const synced = await person({ synced: true });
    await register(synced);
    for (let i = 0; i < 3; i++) {
      await passkeySignIn(synced.device.get(await signInOptions())).expect(200);
    }
    const [kept] = await db()
      .select({ counter: passkeys.counter, deviceType: passkeys.deviceType })
      .from(passkeys)
      .where(eq(passkeys.userId, synced.id));
    expect(kept).toEqual({ counter: 0, deviceType: 'multiDevice' });
  });

  it('counts passkeys as a way to sign in, both ways', async () => {
    const me = await person();
    const { id } = await register(me);
    await db()
      .update(users)
      .set({ passwordHash: null })
      .where(eq(users.id, me.id));
    // The passkey is the last way in: it stays.
    const refused = await me.agent
      .delete(`/v1/auth/passkeys/${id}`)
      .expect(409);
    expect(refused.body.code).toBe('last_sign_in_method');
    // A provider next to it can go: the passkey still signs in…
    await db()
      .insert(userIdentities)
      .values({ provider: 'google', subject: `g-${me.id}`, userId: me.id });
    await me.agent.delete('/v1/auth/identities/google').expect(204);
    // …and with the provider back, the passkey can go, the provider can't.
    await db()
      .insert(userIdentities)
      .values({ provider: 'google', subject: `g-${me.id}`, userId: me.id });
    await me.agent.delete(`/v1/auth/passkeys/${id}`).expect(204);
    const last = await me.agent
      .delete('/v1/auth/identities/google')
      .expect(409);
    expect(last.body.code).toBe('last_sign_in_method');
  });

  it('re-authenticates in place with a passkey', async () => {
    const me = await person();
    await register(me);
    await age(me.agent);
    const status = (await me.agent.get('/v1/auth/reauthenticate').expect(200))
      .body;
    expect(status.methods).toEqual(
      expect.arrayContaining(['password', 'passkey']),
    );
    await me.agent
      .post('/v1/auth/passkeys/registration/options')
      .set('Origin', WEB)
      .expect(403);

    const ask = async () =>
      (
        await me.agent
          .post('/v1/auth/passkeys/reauthentication/options')
          .set('Origin', WEB)
          .expect(200)
      ).body;
    // Presence alone proves possession, not the person: refused.
    const unverified = await me.agent
      .post('/v1/auth/reauthenticate')
      .set('X-Forwarded-For', ip())
      .set('Origin', WEB)
      .send({ passkey: me.device.get(await ask(), { uv: false }) })
      .expect(403);
    expect(unverified.body.code).toBe('reauthentication_failed');
    // A sign-in's challenge isn't a re-authentication's.
    await me.agent
      .post('/v1/auth/reauthenticate')
      .set('X-Forwarded-For', ip())
      .set('Origin', WEB)
      .send({ passkey: me.device.get(await signInOptions()) })
      .expect(403);

    const done = await me.agent
      .post('/v1/auth/reauthenticate')
      .set('X-Forwarded-For', ip())
      .set('Origin', WEB)
      .send({ passkey: me.device.get(await ask()) })
      .expect(200);
    expect(Date.parse(done.body.recentUntil)).toBeGreaterThan(Date.now());
    await me.agent
      .post('/v1/auth/passkeys/registration/options')
      .set('Origin', WEB)
      .expect(200);
    const reasons = (
      await db()
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.action, 'auth.reauthentication-failed'))
        .orderBy(auditLog.id)
    ).map((row) => (row.details as { reason: string }).reason);
    expect(reasons).toEqual(['passkey:user-verification', 'passkey:challenge']);
  });

  it('signs a token client in with a passkey; with two-factor on, a code goes with it', async () => {
    const me = await person();
    await register(me);
    const tokens = await node
      .http()
      .post('/v1/auth/passkeys/token')
      .set('X-Forwarded-For', ip())
      .send({ response: me.device.get(await signInOptions({}, ip(), null)) })
      .expect(200);
    const meNow = await node
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.body.accessToken}`)
      .expect(200);
    expect(meNow.body.authentication).toMatchObject({
      via: 'token',
      method: 'passkey',
    });

    const recoveryCodes = await enableMfa(me);
    const missing = await node
      .http()
      .post('/v1/auth/passkeys/token')
      .set('X-Forwarded-For', ip())
      .send({ response: me.device.get(await signInOptions({}, ip(), null)) })
      .expect(401);
    expect(JSON.stringify(missing.body)).toContain('mfa_required');
    await node
      .http()
      .post('/v1/auth/passkeys/token')
      .set('X-Forwarded-For', ip())
      .send({
        response: me.device.get(await signInOptions({}, ip(), null)),
        recoveryCode: recoveryCodes.pop(),
      })
      .expect(200);
  });

  it('limits the public ceremonies per address, whatever email they name', async () => {
    const address = ip();
    for (let i = 0; i < 30; i++) {
      await signInOptions(
        i % 2 ? { email: `${randomUUID().slice(0, 8)}@example.com` } : {},
        address,
      );
    }
    const limited = await node
      .http()
      .post('/v1/auth/passkeys/sign-in/options')
      .set('X-Forwarded-For', address)
      .send({ email: `${randomUUID().slice(0, 8)}@example.com` })
      .expect(429);
    expect(limited.body.code).toBe('rate_limited');
    // The answers share the budget.
    await node
      .http()
      .post('/v1/auth/passkeys/sign-in')
      .set('X-Forwarded-For', address)
      .send({ response: {} })
      .expect(429);
    // Another address has its own.
    await signInOptions({}, ip());
  });

  it('puts passkeys in the data export and erases them with the account', async () => {
    const me = await person();
    await register(me, 'Laptop');
    const principal = (await node.app.get(UsersRepository).findActive(me.id))!;
    const exported: { kind: string; data: Record<string, unknown> }[] = [];
    for await (const batch of node.app
      .get(AccountTransfer)
      .batches(principal)) {
      exported.push(...batch);
    }
    const [passkey] = exported.filter((row) => row.kind === 'passkey');
    expect(passkey.data).toMatchObject({
      name: 'Laptop',
      credentialId: me.device.credentials[0].id,
    });
    expect(passkey.data).not.toHaveProperty('publicKey');
    await db().transaction((tx) =>
      node.app.get(UsersRepository).anonymize(tx, me.id),
    );
    expect(
      await db().select().from(passkeys).where(eq(passkeys.userId, me.id)),
    ).toEqual([]);
  });

  it('serves the native apps’ association files from configuration', async () => {
    const links = await node
      .http()
      .get('/.well-known/assetlinks.json')
      .expect(200);
    expect(links.body).toEqual([
      {
        relation: [
          'delegate_permission/common.handle_all_urls',
          'delegate_permission/common.get_login_creds',
        ],
        target: {
          namespace: 'android_app',
          package_name: 'com.example.app',
          sha256_cert_fingerprints: [ANDROID_FINGERPRINT],
        },
      },
    ]);
    const apple = await node
      .http()
      .get('/.well-known/apple-app-site-association')
      .expect('Content-Type', /application\/json/)
      .expect(200);
    expect(apple.body).toEqual({
      webcredentials: { apps: ['ABCDE12345.com.example.app'] },
    });
    // GET /auth/methods tells the sign-in page.
    expect(
      (await node.http().get('/v1/auth/methods').expect(200)).body.passkeys,
    ).toBe(true);
  });
});
