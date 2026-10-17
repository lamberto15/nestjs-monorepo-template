/**
 * Edge cases of identity and access (docs/auth.md, docs/permissions.md):
 * sign-in normalization, sessions, tokens, API keys, impersonation, MFA
 * lockout, field-level permissions with conditions, and how fast changes to
 * roles and teams apply.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootApp, newPassword, totp, type TestApp } from './support.js';

describe('identity and access, edge cases (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(() => node.close());

  const browser = () => request.agent(node.app.getHttpServer());
  const email = () => `${randomUUID().slice(0, 8)}@example.com`;

  /**
   * A user who accepted an invitation (their own password), not signed in
   * (sign-ins are limited to 5 per email).
   */
  async function account(roleKeys: string[] = []) {
    const address = email();
    const token = await node.invite(node.admin(), {
      email: address,
      roleIds: await node.roleIds(...roleKeys),
    });
    const password = await node.acceptAsNew(token, address);
    const listed = await node
      .admin()
      .get(`/v1/access/users?email=${encodeURIComponent(address)}`)
      .expect(200);
    return { id: listed.body.items[0].id as string, email: address, password };
  }

  const notesAs = (auth: string) =>
    node.http().get('/v1/test-items').set('Authorization', auth);

  describe('sign-in and sessions', () => {
    it('finds the account whatever the case of the email', async () => {
      const user = await account();
      const shouted = user.email.toUpperCase();
      const res = await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: shouted, password: user.password })
        .expect(200);
      expect(res.body).toEqual({ signedIn: true, mfaRequired: false });
    });

    it('stores a new email in lower case, so two spellings are one account', async () => {
      const local = `Mixed.${randomUUID().slice(0, 8)}`;
      const lower = `${local.toLowerCase()}@example.com`;
      const created = await node
        .admin()
        .post('/v1/access/users')
        .send({ email: `${local}@Example.COM`, name: 'Mixed', roleIds: [] })
        .expect(202);
      expect(created.body.email).toBe(lower);
      const password = await node.acceptInvitation(lower);
      await node.signIn(`${local}@EXAMPLE.com`, password);
      // Invited again in another spelling: the same address, one account.
      await node
        .admin()
        .post('/v1/access/users')
        .send({ email: lower.toUpperCase(), roleIds: [] })
        .expect(202);
      const listed = await node
        .admin()
        .get(`/v1/access/users?email=${encodeURIComponent(lower)}`)
        .expect(200);
      expect(listed.body.items).toHaveLength(1);
    });

    it('signs in with spaces around the email (a paste), and refuses invisible or non-ASCII characters (400)', async () => {
      const user = await account();
      await node
        .http()
        .post('/v1/auth/sign-in')
        .send({ email: ` ${user.email} `, password: user.password })
        .expect(200);
      for (const address of [
        user.email.replace('@', '\u200b@'),
        'ädmin@example.com',
      ]) {
        const res = await node
          .http()
          .post('/v1/auth/sign-in')
          .send({ email: address, password: user.password });
        expect(res.status, JSON.stringify(address)).toBe(400);
        expect(res.body.errors[0].path).toBe('email');
      }
    });

    it('never signs in an account whose email differs only by Unicode normalization', async () => {
      // "é" composed (NFC) and decomposed (NFD) look the same; ASCII-only emails refuse both.
      for (const address of ['café@example.com', 'café@example.com']) {
        await node
          .http()
          .post('/v1/auth/sign-in')
          .send({ email: address, password: newPassword() })
          .expect(400);
      }
    });

    it('answers sign-out without a session with 401, and a second sign-out too', async () => {
      await node.http().post('/v1/auth/sign-out').expect(401);
      const user = await account();
      const agent = await node.signIn(user.email, user.password);
      await agent.post('/v1/auth/sign-out').expect(204);
      await agent.post('/v1/auth/sign-out').expect(401);
      await agent.get('/v1/auth/me').expect(401);
    });

    it('refuses a forged session cookie', async () => {
      await node
        .http()
        .get('/v1/auth/me')
        .set('Cookie', `sid=${randomUUID()}`)
        .expect(401);
      await node.http().get('/v1/auth/me').set('Cookie', 'sid=%%%').expect(401);
    });

    it('needs the current password to be right even with a valid session', async () => {
      const user = await account();
      const agent = await node.signIn(user.email, user.password);
      await agent
        .post('/v1/auth/password/change')
        .send({ currentPassword: newPassword(), newPassword: newPassword() })
        .expect(403);
      // Too short a new password: refused before anything changes.
      await agent
        .post('/v1/auth/password/change')
        .send({ currentPassword: user.password, newPassword: 'short' })
        .expect(400);
      await agent.get('/v1/auth/me').expect(200);
    });
  });

  describe('tokens', () => {
    it('refuses a garbage refresh token (401) and a missing one (400)', async () => {
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: randomUUID() })
        .expect(401);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: 'x'.repeat(513) })
        .expect(400);
      await node.http().post('/v1/auth/token/refresh').send({}).expect(400);
    });

    it('refuses a garbage access token, and an unsigned one (alg none)', async () => {
      const user = await account();
      const b64 = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
        sub: user.id,
        exp: Math.floor(Date.now() / 1000) + 600,
      })}.`;
      for (const token of ['garbage', 'a.b.c', unsigned]) {
        await node
          .http()
          .get('/v1/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
      }
    });

    it('stops the access and refresh tokens of a deactivated user at once', async () => {
      const user = await account();
      const issued = await node
        .http()
        .post('/v1/auth/token')
        .send({ email: user.email, password: user.password })
        .expect(200);
      const bearer = `Bearer ${issued.body.accessToken}`;
      await node
        .http()
        .get('/v1/auth/me')
        .set('Authorization', bearer)
        .expect(200);
      await node
        .admin()
        .patch(`/v1/access/users/${user.id}`)
        .send({ active: false })
        .expect(204);
      await node
        .http()
        .get('/v1/auth/me')
        .set('Authorization', bearer)
        .expect(401);
      await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken: issued.body.refreshToken })
        .expect(401);
    });
  });

  describe('API keys', () => {
    it('refuses malformed keys, other prefixes and unknown ids: 401 problems', async () => {
      const client = await node.client();
      const [, id] = client.key.split('_');
      const cases = [
        'sk_nothex_abc',
        `sk_${id}`,
        `sk_${id}_short`,
        `pk_${id}_${'a'.repeat(43)}`,
        `sk_${'0'.repeat(16)}_${'a'.repeat(43)}`,
        `${client.key}x`,
        client.key.toUpperCase(),
      ];
      for (const key of cases) {
        const res = await notesAs(`Bearer ${key}`);
        expect(res.status, key).toBe(401);
        expect(res.headers['content-type']).toMatch(/problem\+json/);
        expect(JSON.stringify(res.body)).not.toContain(client.key);
      }
      // Another scheme, or no scheme.
      await notesAs(`Token ${client.key}`).expect(401);
      await notesAs(client.key).expect(401);
      await notesAs(client.auth).expect(200);
    });

    it('stops a deactivated client, and lets it in again once reactivated', async () => {
      const client = await node.client();
      await node
        .admin()
        .patch(`/v1/access/clients/${client.id}`)
        .send({ active: false })
        .expect(200);
      await notesAs(client.auth).expect(401);
      await node
        .admin()
        .patch(`/v1/access/clients/${client.id}`)
        .send({ active: true })
        .expect(200);
      await notesAs(client.auth).expect(200);
    });

    it('rotates with grace 0 (the default) at once, and with a grace period keeps both keys', async () => {
      const client = await node.client();
      const noBody = await node
        .admin()
        .post(`/v1/access/clients/${client.id}/rotate`)
        .expect(200);
      await notesAs(client.auth).expect(401);
      const second = `Bearer ${noBody.body.key}`;
      await notesAs(second).expect(200);

      const graceful = await node
        .admin()
        .post(`/v1/access/clients/${client.id}/rotate`)
        .send({ graceSeconds: 3600 })
        .expect(200);
      const third = `Bearer ${graceful.body.key}`;
      await notesAs(second).expect(200);
      await notesAs(third).expect(200);
      const ending = graceful.body.keys.find((key: { keyId: string }) =>
        second.includes(key.keyId),
      );
      expect(new Date(ending.expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 3500_000,
      );

      // A rotation with grace 0 ends the key still in its grace period too.
      const now = await node
        .admin()
        .post(`/v1/access/clients/${client.id}/rotate`)
        .send({ graceSeconds: 0 })
        .expect(200);
      await notesAs(second).expect(401);
      await notesAs(third).expect(401);
      await notesAs(`Bearer ${now.body.key}`).expect(200);
    });

    it('refuses grace periods out of range', async () => {
      const client = await node.client();
      for (const graceSeconds of [-1, 1.5, 30 * 86_400 + 1, '60', null]) {
        await node
          .admin()
          .post(`/v1/access/clients/${client.id}/rotate`)
          .send({ graceSeconds })
          .expect(400);
      }
      await notesAs(client.auth).expect(200);
    });

    it("never revokes another client's key through the wrong client's path", async () => {
      const a = await node.client();
      const b = await node.client();
      const listed = await node.admin().get('/v1/access/clients').expect(200);
      const bKey = listed.body.items.find((c: { id: string }) => c.id === b.id)
        .keys[0].id;
      await node
        .admin()
        .delete(`/v1/access/clients/${a.id}/keys/${bKey}`)
        .expect(404);
      await notesAs(b.auth).expect(200);
      // Revoking twice: the second is a 404.
      await node
        .admin()
        .delete(`/v1/access/clients/${b.id}/keys/${bKey}`)
        .expect(204);
      await node
        .admin()
        .delete(`/v1/access/clients/${b.id}/keys/${bKey}`)
        .expect(404);
      await notesAs(b.auth).expect(401);
    });

    it('answers 404 for routes on a client that does not exist', async () => {
      const missing = randomUUID();
      await node
        .admin()
        .post(`/v1/access/clients/${missing}/rotate`)
        .expect(404);
      await node
        .admin()
        .patch(`/v1/access/clients/${missing}`)
        .send({ active: false })
        .expect(404);
      await node
        .admin()
        .post('/v1/access/clients/not-a-uuid/rotate')
        .expect(400);
    });
  });

  describe('impersonation', () => {
    /** A second administrator, signed in: impersonating replaces their session. */
    async function administrator() {
      const admin = await account(['administrator']);
      const agent = await node.signIn(admin.email, admin.password);
      return { ...admin, agent };
    }

    it('answers stop without an impersonation with 409', async () => {
      const { agent } = await administrator();
      const res = await agent.post('/v1/auth/impersonation/stop').expect(409);
      expect(res.body.code).toBe('conflict');
      await agent.get('/v1/auth/me').expect(200);
    });

    it('refuses to impersonate a deactivated, unknown or malformed user', async () => {
      const { agent } = await administrator();
      const target = await account(['editor']);
      await node
        .admin()
        .patch(`/v1/access/users/${target.id}`)
        .send({ active: false })
        .expect(204);
      await agent.post(`/v1/access/users/${target.id}/impersonate`).expect(404);
      await agent
        .post(`/v1/access/users/${randomUUID()}/impersonate`)
        .expect(404);
      await agent.post('/v1/access/users/nope/impersonate').expect(400);
      // Still their own session.
      const me = await agent.get('/v1/auth/me').expect(200);
      expect(me.body.user.impersonator).toBeUndefined();
    });

    it('never nests: an impersonated user who may impersonate still cannot', async () => {
      const role = await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: `Support ${randomUUID().slice(0, 4)}`,
          permissions: [
            { subject: 'Access', action: 'impersonate', conditions: [] },
          ],
        })
        .expect(201);
      const support = await account([role.body.id]);
      const third = await account(['editor']);
      const { agent } = await administrator();
      await agent
        .post(`/v1/access/users/${support.id}/impersonate`)
        .expect(204);
      // The policy refuses it while impersonating (AccessPolicy.impersonate): 403.
      await agent.post(`/v1/access/users/${third.id}/impersonate`).expect(403);
      const me = await agent.get('/v1/auth/me').expect(200);
      expect(me.body.user.id).toBe(support.id);
      await agent.post('/v1/auth/impersonation/stop').expect(204);
    });

    // BUG: GET /auth/me computes `can` with AccessService.can() (the permissions), not with
    // AccessPolicy, which refuses every Access action while impersonating: the frontend
    // would offer buttons whose routes all answer 403.
    it("shows in /auth/me's `can` that access management is off while impersonating", async () => {
      const role = await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: `Support manager ${randomUUID().slice(0, 4)}`,
          permissions: [
            { subject: 'Access', action: 'impersonate', conditions: [] },
            { subject: 'Access', action: 'manageRoles', conditions: [] },
          ],
        })
        .expect(201);
      const support = await account([role.body.id]);
      const { agent } = await administrator();
      await agent
        .post(`/v1/access/users/${support.id}/impersonate`)
        .expect(204);
      await agent.get('/v1/access/roles').expect(403);
      const me = await agent.get('/v1/auth/me').expect(200);
      try {
        expect(me.body.can['Access.manageRoles']).toBe(false);
        expect(me.body.can['Access.impersonate']).toBe(false);
      } finally {
        await agent.post('/v1/auth/impersonation/stop').expect(204);
      }
    });

    it("ends the impersonation's session when stopped; a second stop is a 409", async () => {
      const target = await account(['editor']);
      const { agent, id } = await administrator();
      const started = await agent
        .post(`/v1/access/users/${target.id}/impersonate`)
        .expect(204);
      const impersonationCookie = (
        started.headers['set-cookie'] as unknown as string[]
      )
        .map((cookie) => cookie.split(';')[0])
        .join('; ');
      await node
        .http()
        .get('/v1/auth/me')
        .set('Cookie', impersonationCookie)
        .expect(200);
      await agent.post('/v1/auth/impersonation/stop').expect(204);
      // The copied cookie of the impersonation is dead.
      await node
        .http()
        .get('/v1/auth/me')
        .set('Cookie', impersonationCookie)
        .expect(401);
      const me = await agent.get('/v1/auth/me').expect(200);
      expect(me.body.user.id).toBe(id);
      await agent.post('/v1/auth/impersonation/stop').expect(409);
    });

    it('refuses impersonation to API clients and tokens: a session only', async () => {
      const target = await account(['editor']);
      const client = await node.client();
      await node
        .http()
        .post(`/v1/access/users/${target.id}/impersonate`)
        .set('Authorization', client.auth)
        .expect(401);
    });
  });

  describe('two-factor lockout', () => {
    it('locks the second step after 5 wrong codes: even a right recovery code is refused', async () => {
      const user = await account();
      const agent = await node.signIn(user.email, user.password);
      const enrollment = await agent.post('/v1/auth/mfa/enroll').expect(200);
      const confirmed = await agent
        .post('/v1/auth/mfa/confirm')
        .send({ code: totp(enrollment.body.secret) })
        .expect(200);
      const [recovery, spare] = confirmed.body.recoveryCodes as string[];

      const second = browser();
      await second
        .post('/v1/auth/sign-in')
        .send({ email: user.email, password: user.password })
        .expect(200, { signedIn: false, mfaRequired: true });
      // Codes that can't be right: this step's code was used to confirm.
      const wrong = (i: number) =>
        String(
          (Number(totp(enrollment.body.secret)) + 1 + i) % 1_000_000,
        ).padStart(6, '0');
      for (let i = 0; i < 5; i++) {
        await second
          .post('/v1/auth/mfa/verify')
          .send({ code: wrong(i) })
          .expect(401);
      }
      await second
        .post('/v1/auth/mfa/verify')
        .send({ recoveryCode: recovery })
        .expect(401);
      await second.get('/v1/auth/me').expect(401);
      // The lock is the account's, not the browser's.
      const third = browser();
      await third
        .post('/v1/auth/sign-in')
        .send({ email: user.email, password: user.password })
        .expect(200);
      await third
        .post('/v1/auth/mfa/verify')
        .send({ recoveryCode: spare })
        .expect(401);
      // Tokens too.
      await node
        .http()
        .post('/v1/auth/token')
        .send({
          email: user.email,
          password: user.password,
          recoveryCode: spare,
        })
        .expect(401);
    });

    it('refuses the second step without a pending sign-in', async () => {
      await browser()
        .post('/v1/auth/mfa/verify')
        .send({ code: '123456' })
        .expect(401);
      await browser().post('/v1/auth/mfa/verify').send({}).expect(400);
      await browser()
        .post('/v1/auth/mfa/verify')
        .send({ code: '12345' })
        .expect(400);
    });
  });

  describe('permissions', () => {
    const role = async (name: string, permissions: unknown[]) =>
      (
        await node
          .admin()
          .post('/v1/access/roles')
          .send({ name: `${name} ${randomUUID().slice(0, 6)}`, permissions })
          .expect(201)
      ).body.id as string;

    it('combines fields with conditions: the text of my notes only, and changes without the text', async () => {
      const seeAllTitles = await role('Titles', [
        { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
      ]);
      const ownText = await role('Own text', [
        {
          subject: 'TestItem',
          action: 'read',
          conditions: [{ key: 'mine' }],
          fields: ['body'],
        },
        { subject: 'TestItem', action: 'create', conditions: [] },
        {
          subject: 'TestItem',
          action: 'update',
          conditions: [{ key: 'mine' }],
          fields: [],
        },
      ]);
      const { agent } = await node.user([seeAllTitles, ownText]);
      const mine = (
        await node
          .writeItem(agent, { title: 'Mine', body: 'my text' })
          .expect(201)
      ).body;
      const other = await node.client();
      const theirs = (
        await node
          .writeItem(other.auth, { title: 'Theirs', body: 'their text' })
          .expect(201)
      ).body;

      const listed = (await agent.get('/v1/test-items').expect(200)).body
        .items as {
        id: string;
        body?: string;
      }[];
      expect(listed.find((n) => n.id === mine.id)?.body).toBe('my text');
      const listedTheirs = listed.find((n) => n.id === theirs.id)!;
      expect(listedTheirs).toBeDefined();
      expect(listedTheirs).not.toHaveProperty('body');
      expect(
        (await agent.get(`/v1/test-items/${theirs.id}`).expect(200)).body,
      ).not.toHaveProperty('body');
      expect(
        (await agent.get(`/v1/test-items/${mine.id}`).expect(200)).body.body,
      ).toBe('my text');

      // Changing the title of my note: yes; its text: no; their note: no.
      const renamed = await agent
        .patch(`/v1/test-items/${mine.id}`)
        .send({ title: 'Renamed' })
        .expect(200);
      expect(renamed.body).toMatchObject({ title: 'Renamed', body: 'my text' });
      const refused = await agent
        .patch(`/v1/test-items/${mine.id}`)
        .send({ title: 'Again', body: 'new text' })
        .expect(403);
      expect(refused.body).toMatchObject({
        code: 'field_forbidden',
        fields: ['body'],
      });
      // Nothing of the refused change was saved.
      expect(
        (await agent.get(`/v1/test-items/${mine.id}`).expect(200)).body.title,
      ).toBe('Renamed');
      await agent
        .patch(`/v1/test-items/${theirs.id}`)
        .send({ title: 'Mine now' })
        .expect(403);
    });

    it("refuses to grant fields or conditions-free access the granter doesn't hold: 403", async () => {
      const limited = await role('Limited manager', [
        { subject: 'Access', action: 'manageRoles', conditions: [] },
        { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
        {
          subject: 'TestItem',
          action: 'update',
          conditions: [{ key: 'mine' }],
        },
      ]);
      const { agent } = await node.user([limited]);
      const attempt = (permissions: unknown[]) =>
        agent
          .post('/v1/access/roles')
          .send({ name: `Attempt ${randomUUID().slice(0, 6)}`, permissions });
      // Every field (fields left out), or the text explicitly: not held.
      await attempt([
        { subject: 'TestItem', action: 'read', conditions: [] },
      ]).expect(403);
      await attempt([
        {
          subject: 'TestItem',
          action: 'read',
          conditions: [],
          fields: ['body'],
        },
      ]).expect(403);
      // Held with a condition only: can't be granted, with or without it.
      await attempt([
        {
          subject: 'TestItem',
          action: 'update',
          conditions: [{ key: 'mine' }],
        },
      ]).expect(403);
      // Exactly what is held without conditions: fine.
      await attempt([
        { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
      ]).expect(201);
      // Unknown fields: a 400, not a silent grant.
      await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: 'Unknown field',
          permissions: [
            {
              subject: 'TestItem',
              action: 'read',
              conditions: [],
              fields: ['secret'],
            },
          ],
        })
        .expect(400);
    });

    it('applies team membership changes on the next request', async () => {
      const admin = node.admin();
      const newTeam = async (name: string, parentId?: string) =>
        (
          await admin
            .post('/v1/access/teams')
            .send({ name: `${name} ${randomUUID().slice(0, 4)}`, parentId })
            .expect(201)
        ).body.id as string;
      const team = await newTeam('Team');
      const other = await newTeam('Other');
      const writer = await node.user(['editor']);
      await admin
        .patch(`/v1/access/users/${writer.id}`)
        .send({ teamIds: [team] })
        .expect(204);
      await node
        .writeItem(writer.agent, { title: 'Team note', body: 'x' })
        .expect(201);

      const lead = await node.user(['team-lead']);
      const titles = async () =>
        (
          (await lead.agent.get('/v1/test-items').expect(200)).body.items as {
            title: string;
          }[]
        ).map((n) => n.title);
      expect(await titles()).toEqual([]);
      await admin
        .patch(`/v1/access/users/${lead.id}`)
        .send({ teamIds: [team] })
        .expect(204);
      expect(await titles()).toEqual(['Team note']);
      await admin
        .patch(`/v1/access/users/${lead.id}`)
        .send({ teamIds: [other] })
        .expect(204);
      expect(await titles()).toEqual([]);
      // Moving the team under the lead's team: seen at once, on a cached ability.
      await admin
        .patch(`/v1/access/teams/${team}`)
        .send({ parentId: other })
        .expect(200);
      expect(await titles()).toEqual(['Team note']);
      const note = (await lead.agent.get('/v1/test-items').expect(200)).body
        .items[0];
      await lead.agent.get(`/v1/test-items/${note.id}`).expect(200);
      // And back to the top: gone again, in the list and the record.
      await admin
        .patch(`/v1/access/teams/${team}`)
        .send({ parentId: null })
        .expect(200);
      expect(await titles()).toEqual([]);
      await lead.agent.get(`/v1/test-items/${note.id}`).expect(403);
    });

    it('takes access away when a role is deleted or narrowed, from the next request', async () => {
      const opsRole = await role('Ops view', [
        { subject: 'Ops', action: 'view', conditions: [] },
      ]);
      const readAll = await role('Read all', [
        { subject: 'TestItem', action: 'read', conditions: [] },
      ]);
      const { agent } = await node.user([opsRole, readAll]);
      const other = await node.client();
      await node
        .writeItem(other.auth, { title: 'Not mine', body: 'x' })
        .expect(201);

      await agent.get('/v1/ops/outbox').expect(200);
      expect(
        (await agent.get('/v1/test-items').expect(200)).body.items.length,
      ).toBeGreaterThan(0);
      expect(
        (await agent.get('/v1/auth/me').expect(200)).body.can['Ops.view'],
      ).toBe(true);

      await node.admin().delete(`/v1/access/roles/${opsRole}`).expect(204);
      await agent.get('/v1/ops/outbox').expect(403);
      expect(
        (await agent.get('/v1/auth/me').expect(200)).body.can['Ops.view'],
      ).toBe(false);

      await node
        .admin()
        .patch(`/v1/access/roles/${readAll}`)
        .send({
          name: 'Read mine',
          permissions: [
            {
              subject: 'TestItem',
              action: 'read',
              conditions: [{ key: 'mine' }],
            },
          ],
        })
        .expect(204);
      expect(
        (await agent.get('/v1/test-items').expect(200)).body.items,
      ).toEqual([]);
      // A deleted role is gone for good: 404.
      await node.admin().delete(`/v1/access/roles/${opsRole}`).expect(404);
    });

    it('takes a deleted role away from API clients too', async () => {
      const readAll = await role('Client reads all', [
        { subject: 'TestItem', action: 'read', conditions: [] },
      ]);
      const writer = await node.client();
      await node
        .writeItem(writer.auth, { title: 'For the reader', body: 'x' })
        .expect(201);
      const reader = await node.client();
      await node
        .admin()
        .patch(`/v1/access/clients/${reader.id}`)
        .send({ roleIds: [readAll] })
        .expect(200);
      expect(
        (await notesAs(reader.auth).expect(200)).body.items.length,
      ).toBeGreaterThan(0);
      await node.admin().delete(`/v1/access/roles/${readAll}`).expect(204);
      expect((await notesAs(reader.auth).expect(200)).body.items).toEqual([]);
    });

    it('refuses to grant a role id that does not exist', async () => {
      const { id } = await account();
      const res = await node
        .admin()
        .patch(`/v1/access/users/${id}`)
        .send({ roleIds: [randomUUID()] });
      expect([400, 404]).toContain(res.status);
      expect(res.headers['content-type']).toMatch(/problem\+json/);
    });
  });
});
