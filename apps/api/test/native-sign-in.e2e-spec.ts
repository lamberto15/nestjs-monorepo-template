import { createHash, randomBytes } from 'node:crypto';
import { OidcService } from '@nestjs/authentication';
import { ForbiddenException } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Database } from '../src/core/database/drizzle.js';
import { OidcAccounts } from '../src/iam/account/account.handlers.js';
import { userIdentities } from '../src/iam/iam.tables.js';
import { bootApp, totp, type TestApp } from './support.js';

// A configured GitHub (an OAuth 2.0 provider with fixed endpoints: no
// discovery) and the app's redirect URI, read once when AppModule loads.
vi.hoisted(() => {
  Object.assign(process.env, {
    GITHUB_CLIENT_ID: 'native-test',
    // Made at runtime (a local hook refuses key-like literals).
    GITHUB_CLIENT_SECRET: crypto.randomUUID(),
    NATIVE_REDIRECT_URIS: 'com.example.app:/auth',
  });
});

const REDIRECT_URI = 'com.example.app:/auth';

/** A PKCE pair (RFC 7636, S256). */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

describe('native sign-in: handoff codes for provider sign-ins and magic links (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await node.close();
  });

  /** A user with GitHub connected. */
  async function person() {
    const user = await node.user([]);
    await node.app
      .get<Database>(getDrizzleToken())
      .insert(userIdentities)
      .values({
        provider: 'github',
        subject: `gh-${user.id}`,
        userId: user.id,
      });
    return user;
  }

  /** GitHub's answer, simulated as the real resolver would get it (no provider is reached). */
  function providerAnswers(subject: string) {
    const resolver = node.app.get(OidcAccounts);
    return vi
      .spyOn(node.app.get(OidcService), 'finish')
      .mockImplementation(async () => {
        const user = await resolver.resolveUser(
          { provider: 'github', subject, emailVerified: true, claims: {} },
          { accessToken: 'at' },
          {},
        );
        // As the package: an account the resolver refuses is a 403.
        if (!user) {
          throw new ForbiddenException('account not allowed');
        }
        return { url: '/', cookies: [], userId: user.id };
      });
  }

  /** A native login through GitHub, to its callback: where the browser lands. */
  async function nativeLogin(challenge: string) {
    const started = await node
      .http()
      .get('/v1/auth/oidc/github/login')
      .query({ redirectUri: REDIRECT_URI, codeChallenge: challenge })
      .expect(302);
    const state = new URL(started.headers.location!).searchParams.get('state')!;
    return node
      .http()
      .get('/v1/auth/oidc/github/callback')
      .query({ state, code: 'provider-code' })
      .expect(302);
  }

  const exchange = (body: Record<string, unknown>) =>
    node.http().post('/v1/auth/token/exchange').send(body);

  it('hands a provider sign-in to the app as a one-time, PKCE-bound code', async () => {
    const me = await person();
    const finish = providerAnswers(`gh-${me.id}`);
    // Only an allow-listed redirect URI, and with its challenge.
    const { verifier, challenge } = pkce();
    await node
      .http()
      .get('/v1/auth/oidc/github/login')
      .query({ redirectUri: 'com.evil.app:/auth', codeChallenge: challenge })
      .expect(400);
    await node
      .http()
      .get('/v1/auth/oidc/github/login')
      .query({ redirectUri: REDIRECT_URI })
      .expect(400);

    const landed = await nativeLogin(challenge);
    expect(finish).toHaveBeenCalledWith('github', expect.anything(), {
      signIn: false,
    });
    expect(landed.headers['set-cookie'] ?? []).not.toContainEqual(
      expect.stringMatching(/session/i),
    );
    const back = new URL(landed.headers.location!);
    expect(`${back.protocol}${back.pathname}`).toBe(REDIRECT_URI);
    const code = back.searchParams.get('code')!;

    // Another verifier: refused, and the code is spent.
    await exchange({
      handoffCode: code,
      codeVerifier: pkce().verifier,
    }).expect(401);
    await exchange({ handoffCode: code, codeVerifier: verifier }).expect(401);

    const again = pkce();
    const next = new URL(
      (await nativeLogin(again.challenge)).headers.location!,
    ).searchParams.get('code')!;
    const tokens = await exchange({
      handoffCode: next,
      codeVerifier: again.verifier,
    }).expect(200);
    const signedIn = await node
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.body.accessToken}`)
      .expect(200);
    expect(signedIn.body.user.id).toBe(me.id);
    expect(signedIn.body.tenant.id).toBe(node.tenantId);
    // Once.
    await exchange({
      handoffCode: next,
      codeVerifier: again.verifier,
    }).expect(401);
    const [entry] = (await node.auditEntries({
      action: 'auth.signed-in',
      actor: `user:${me.id}`,
    })) as { details: Record<string, unknown> }[];
    expect(entry.details).toMatchObject({
      method: 'oidc:github',
      via: 'token',
    });
  });

  it('asks for the second factor without spending the code', async () => {
    const me = await person();
    const enrollment = await me.agent.post('/v1/auth/mfa/enroll').expect(200);
    const confirmed = await me.agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(enrollment.body.secret) })
      .expect(200);
    const [recoveryCode] = confirmed.body.recoveryCodes as string[];
    providerAnswers(`gh-${me.id}`);
    const { verifier, challenge } = pkce();
    const code = new URL(
      (await nativeLogin(challenge)).headers.location!,
    ).searchParams.get('code')!;

    const asked = await exchange({
      handoffCode: code,
      codeVerifier: verifier,
    }).expect(401);
    expect(JSON.stringify(asked.body)).toContain('mfa_required');
    await exchange({
      handoffCode: code,
      codeVerifier: verifier,
      recoveryCode,
    }).expect(200);
  });

  it('hands a magic link opened by the app to it, in the app that asked only', async () => {
    const me = await person();
    const app = request.agent(node.app.getHttpServer());
    await app.post('/v1/auth/magic-link').send({ email: me.email }).expect(202);
    const mail = await node.waitForMail({
      to: me.email,
      subject: 'Your sign-in link',
    });
    const token = mail.link('/magic-link').searchParams.get('token')!;
    const { verifier, challenge } = pkce();

    await node
      .http()
      .post('/v1/auth/magic-link/handoff')
      .send({ token, codeChallenge: challenge })
      .expect(401);
    const handed = await app
      .post('/v1/auth/magic-link/handoff')
      .send({ token, codeChallenge: challenge })
      .expect(200);
    const tokens = await exchange({
      handoffCode: handed.body.code,
      codeVerifier: verifier,
    }).expect(200);
    await node
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.body.accessToken}`)
      .expect(200);
    // The link is spent.
    await app
      .post('/v1/auth/magic-link/handoff')
      .send({ token, codeChallenge: challenge })
      .expect(401);
  });

  describe('a signed-in app links a provider, or steps up through one', () => {
    /** The user's tokens, as the app holds them. */
    async function tokensOf(user: { email: string; password: string }) {
      const issued = await node
        .http()
        .post('/v1/auth/token')
        .send({ email: user.email, password: user.password })
        .expect(200);
      return issued.body as { accessToken: string; refreshToken: string };
    }

    const ticket = (
      accessToken: string,
      purpose: 'link' | 'reauthenticate',
      challenge: string,
    ) =>
      node
        .http()
        .post('/v1/auth/identities/github/native')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ purpose, redirectUri: REDIRECT_URI, codeChallenge: challenge });

    /** The ticket's URL opened in the system browser, to its callback: where it lands. */
    async function openTicket(url: string) {
      const { pathname, search } = new URL(url);
      const started = await node.http().get(`${pathname}${search}`).expect(302);
      const provider = new URL(started.headers.location!);
      const landed = await node
        .http()
        .get('/v1/auth/oidc/github/callback')
        .query({ state: provider.searchParams.get('state'), code: 'pc' })
        .expect(302);
      return { provider, back: new URL(landed.headers.location!) };
    }

    const complete = (accessToken: string, body: Record<string, unknown>) =>
      node
        .http()
        .post('/v1/auth/identities/native/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body);

    const identitiesOf = (userId: string) =>
      node.db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId));

    it('links GitHub with a one-time ticket, completed by the session that asked only', async () => {
      const me = await node.user([]);
      const other = await node.user([]);
      const mine = await tokensOf(me);
      providerAnswers(`gh-new-${me.id}`);
      // A browser session links with ?link=true, not a ticket.
      await me.agent
        .post('/v1/auth/identities/github/native')
        .send({
          purpose: 'link',
          redirectUri: REDIRECT_URI,
          codeChallenge: pkce().challenge,
        })
        .expect(400);
      await node
        .http()
        .post('/v1/auth/identities/github/native')
        .set('Authorization', `Bearer ${mine.accessToken}`)
        .send({
          purpose: 'link',
          redirectUri: 'com.evil.app:/auth',
          codeChallenge: pkce().challenge,
        })
        .expect(400);

      // Another user's token: refused, and the code is spent.
      const first = pkce();
      const { url } = (
        await ticket(mine.accessToken, 'link', first.challenge).expect(201)
      ).body as { url: string };
      const { back } = await openTicket(url);
      const code = back.searchParams.get('code')!;
      await complete((await tokensOf(other)).accessToken, {
        handoffCode: code,
        codeVerifier: first.verifier,
      }).expect(401);
      await complete(mine.accessToken, {
        handoffCode: code,
        codeVerifier: first.verifier,
      }).expect(401);
      // The ticket worked once.
      const { pathname, search } = new URL(url);
      await node.http().get(`${pathname}${search}`).expect(400);
      expect(await identitiesOf(other.id)).toEqual([]);
      // Its callback ran, yet nothing is linked: only a completion links
      // (a ticket opened in someone else's browser links nothing).
      expect(await identitiesOf(me.id)).toEqual([]);

      // Never a sign-in: the exchange refuses a link's code.
      const second = pkce();
      const next = await openTicket(
        (await ticket(mine.accessToken, 'link', second.challenge).expect(201))
          .body.url,
      );
      await exchange({
        handoffCode: next.back.searchParams.get('code'),
        codeVerifier: second.verifier,
      }).expect(401);

      const third = pkce();
      const last = await openTicket(
        (await ticket(mine.accessToken, 'link', third.challenge).expect(201))
          .body.url,
      );
      const linked = await complete(mine.accessToken, {
        handoffCode: last.back.searchParams.get('code'),
        codeVerifier: third.verifier,
      }).expect(200);
      expect(linked.body).toMatchObject({
        purpose: 'link',
        identity: { provider: 'github' },
      });
      expect(await identitiesOf(me.id)).toMatchObject([
        { provider: 'github', subject: `gh-new-${me.id}` },
      ]);
      expect(
        await node.auditEntries({
          action: 'user.identity-linked',
          targetId: me.id,
        }),
      ).toHaveLength(1);
    });

    it("refuses to link an identity that is another account's, and changes nothing", async () => {
      const owner = await person();
      const me = await node.user([]);
      const mine = await tokensOf(me);
      providerAnswers(`gh-${owner.id}`);
      const { challenge } = pkce();
      const { back } = await openTicket(
        (await ticket(mine.accessToken, 'link', challenge).expect(201)).body
          .url,
      );
      expect(back.searchParams.get('error')).toBe('link_failed');
      expect(back.searchParams.get('code')).toBeNull();
      expect(await identitiesOf(me.id)).toEqual([]);
      expect(await identitiesOf(owner.id)).toHaveLength(1);
    });

    it('steps up through a connected provider: new tokens, for that user only', async () => {
      const me = await person();
      const mine = await tokensOf(me);
      providerAnswers(`gh-${me.id}`);
      const { verifier, challenge } = pkce();
      const { provider, back } = await openTicket(
        (
          await ticket(mine.accessToken, 'reauthenticate', challenge).expect(
            201,
          )
        ).body.url,
      );
      // The provider is asked to authenticate the user again.
      expect(provider.searchParams.get('prompt')).toBe('login');
      expect(provider.searchParams.get('max_age')).toBe('0');
      const stepped = await complete(mine.accessToken, {
        handoffCode: back.searchParams.get('code'),
        codeVerifier: verifier,
        refreshToken: mine.refreshToken,
      }).expect(200);
      expect(stepped.body).toMatchObject({ purpose: 'reauthenticate' });
      const signedIn = await node
        .http()
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${stepped.body.accessToken}`)
        .expect(200);
      expect(signedIn.body.user.id).toBe(me.id);
      // The old pair's family is revoked.
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: mine.refreshToken })
        .expect(401);
      expect(
        await node.auditEntries({
          action: 'auth.reauthenticated',
          actor: `user:${me.id}`,
        }),
      ).toContainEqual(
        expect.objectContaining({
          details: expect.objectContaining({ method: 'oidc', via: 'token' }),
        }),
      );

      // Someone else's GitHub: refused, back in the app with an error.
      const stranger = await person();
      const again = await tokensOf(me);
      providerAnswers(`gh-${stranger.id}`);
      const refused = await openTicket(
        (
          await ticket(
            again.accessToken,
            'reauthenticate',
            pkce().challenge,
          ).expect(201)
        ).body.url,
      );
      expect(refused.back.searchParams.get('error')).toBe(
        'reauthentication_failed',
      );
    });
  });
});
