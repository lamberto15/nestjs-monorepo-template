import { bootApp, newPassword, type TestApp } from './support.js';

describe('authentication (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  const attempt = (email: string, password = newPassword()) =>
    node.http().post('/v1/auth/sign-in').send({ email, password });

  it('answers the health checks without credentials', async () => {
    const ready = await node.http().get('/health').expect(200);
    expect(ready.body).toMatchObject({
      status: 'ok',
      info: { database: { status: 'up' }, redis: { status: 'up' } },
    });
    await node.http().get('/health/live').expect(200);
  });

  it("tells the build's commit to the signed in only", async () => {
    // Anyone would learn which revision of the public template runs here.
    await node.http().get('/health/version').expect(401);
    const answer = await node.admin().get('/health/version').expect(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual({ sha: process.env.GIT_SHA ?? '' });
    const client = await node.client();
    await node
      .http()
      .get('/health/version')
      .set('Authorization', client.auth)
      .expect(200);
  });

  it('sends security headers and a request id on every response', async () => {
    const res = await node.http().get('/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await node
      .http()
      .get('/health')
      .set('X-Request-Id', 'req-from-proxy-1');
    expect(echoed.headers['x-request-id']).toBe('req-from-proxy-1');
  });

  it("answers validation errors in the request's language", async () => {
    const en = await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email: 'nope', password: 'x' })
      .expect(400);
    expect(en.body.errors).toContainEqual({
      path: 'email',
      message: 'email must be an email address',
    });
    expect(en.headers['content-language']).toBe('en');
    const de = await node
      .http()
      .post('/v1/auth/sign-in?lang=de')
      .send({ email: 'nope', password: 'x' })
      .expect(400);
    expect(de.body.errors).toContainEqual({
      path: 'email',
      message: 'email muss eine E-Mail-Adresse sein',
    });
    expect(de.headers['content-language']).toBe('de');
  });

  it('answers every error as problem details (RFC 9457)', async () => {
    const invalid = await node
      .http()
      .post('/v1/auth/sign-in')
      .set('X-Request-Id', 'req-problem-0001')
      .send({ email: 'nope', password: '' })
      .expect(400);
    expect(invalid.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(invalid.body).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'The request is invalid.',
      code: 'validation_failed',
      errors: expect.arrayContaining([
        { path: 'email', message: 'email must be an email address' },
        { path: 'password', message: expect.any(String) },
      ]),
      instance: '/v1/auth/sign-in',
      requestId: 'req-problem-0001',
    });

    const unauthorized = await node.http().get('/v1/test-items').expect(401);
    expect(unauthorized.body).toMatchObject({
      status: 401,
      title: 'Unauthorized',
      code: expect.any(String),
    });
    const missing = await node.http().get('/v1/nowhere').expect(404);
    expect(missing.body).toMatchObject({
      status: 404,
      code: 'not_found',
      instance: '/v1/nowhere',
    });
    const badId = await node
      .admin()
      .get('/v1/test-items/not-a-uuid')
      .expect(400);
    expect(badId.body).toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('serves the API under /v1', async () => {
    await node.http().get('/notes').expect(404);
    await node.http().get('/v1/test-items').expect(401);
  });

  it('closes every data route to guests: 401', async () => {
    await node.http().get('/v1/test-items').expect(401);
    await node.http().get('/v1/auth/me').expect(401);
    await node.http().get('/v1/access/roles').expect(401);
    await node.http().get('/v1/webhook-endpoints').expect(401);
  });

  it('signs users in with a session cookie, and out again', async () => {
    const admin = node.admin();
    const me = await admin.get('/v1/auth/me').expect(200);
    expect(me.body.user).toMatchObject({
      kind: 'user',
      email: 'admin@example.com',
    });
    expect(me.body.can['Access.manageRoles']).toBe(true);

    await admin.post('/v1/auth/sign-out').expect(204);
    await admin.get('/v1/auth/me').expect(401);
  });

  it('answers a wrong password and an unknown email the same way, and audits both', async () => {
    const wrong = await attempt('admin@example.com').expect(401);
    const unknown = await attempt('nobody@example.com').expect(401);
    expect(wrong.body.detail).toBe(unknown.body.detail);

    // An account's own entries, in no tenant's log (docs/tenancy.md).
    expect(
      await node.auditEntries({ action: 'auth.sign-in-failed' }),
    ).toHaveLength(2);
    const tenantLog = await node.admin().get('/v1/access/audit').expect(200);
    expect(
      tenantLog.body.items.filter(
        (entry: { action: string }) => entry.action === 'auth.sign-in-failed',
      ),
    ).toHaveLength(0);
  });

  it('limits sign-in to 5 attempts per email and IP every 15 minutes', async () => {
    for (let i = 0; i < 5; i++) {
      await attempt('target@example.com').expect(401);
    }
    await attempt('target@example.com').expect(429);
    // Another account from the same IP isn't locked out.
    await attempt('other@example.com').expect(401);
  });

  it("refuses a write from another website's page (CSRF): 403", async () => {
    await node
      .http()
      .post('/v1/auth/sign-in')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ email: 'admin@example.com', password: newPassword() })
      .expect(403);
  });

  it('signs a user out of the tenant when deactivated (no administrator sets a password)', async () => {
    const { id } = await node.user(['viewer']);
    await node
      .admin()
      .patch(`/v1/access/users/${id}`)
      .send({ password: newPassword() })
      .expect(400);

    const again = await node.user(['viewer']);
    await node
      .admin()
      .patch(`/v1/access/users/${again.id}`)
      .send({ active: false })
      .expect(204);
    await again.agent.get('/v1/auth/me').expect(401);
  });

  describe('API keys', () => {
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it('rotates with a grace period, revokes one key, and expires keys', async () => {
      const client = await node.client();
      const rotated = await node
        .admin()
        .post(`/v1/access/clients/${client.id}/rotate`)
        .send({ graceSeconds: 1 })
        .expect(200);
      const fresh = `Bearer ${rotated.body.key}`;
      // During the grace period, both keys work: the system can switch without downtime.
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', client.auth)
        .expect(200);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', fresh)
        .expect(200);
      await wait(1200);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', client.auth)
        .expect(401);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', fresh)
        .expect(200);

      const view = await node.admin().get('/v1/access/clients').expect(200);
      const keys = view.body.items.find(
        (c: { id: string }) => c.id === client.id,
      ).keys;
      expect(keys).toHaveLength(2);
      const current = keys[1];
      expect(current.lastUsedAt).not.toBeNull();
      await node
        .admin()
        .delete(`/v1/access/clients/${client.id}/keys/${current.id}`)
        .expect(204);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', fresh)
        .expect(401);

      const shortLived = await node
        .admin()
        .post('/v1/access/clients')
        .send({
          name: `short-${Date.now()}`,
          keyExpiresAt: new Date(Date.now() + 1000).toISOString(),
        })
        .expect(201);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', `Bearer ${shortLived.body.key}`)
        .expect(200);
      await wait(1200);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', `Bearer ${shortLived.body.key}`)
        .expect(401);
    });

    it('gives clients roles on top of what every client may do', async () => {
      const writer = await node.client();
      await node
        .writeItem(writer.auth, { title: 'From writer', body: 'x' })
        .expect(201);
      const reader = await node.client();
      expect(
        (
          await node
            .http()
            .get('/v1/test-items')
            .set('Authorization', reader.auth)
        ).body.items,
      ).toHaveLength(0);
      await node
        .admin()
        .patch(`/v1/access/clients/${reader.id}`)
        .send({ roleIds: await node.roleIds('viewer') })
        .expect(200);
      expect(
        (
          await node
            .http()
            .get('/v1/test-items')
            .set('Authorization', reader.auth)
        ).body.items,
      ).toHaveLength(1);
    });

    it('ends a temporary role grant on time', async () => {
      const writer = await node.client();
      await node
        .writeItem(writer.auth, { title: 'Visible for a while', body: 'x' })
        .expect(201);
      const [viewer] = await node.roleIds('viewer');
      const { agent, id } = await node.user([]);
      await node
        .admin()
        .patch(`/v1/access/users/${id}`)
        .send({
          roleIds: [viewer],
          roleExpiresAt: {
            [viewer]: new Date(Date.now() + 1500).toISOString(),
          },
        })
        .expect(204);
      expect(
        (await agent.get('/v1/test-items').expect(200)).body.items,
      ).toHaveLength(1);
      await wait(1700);
      expect(
        (await agent.get('/v1/test-items').expect(200)).body.items,
      ).toHaveLength(0);
      await node
        .admin()
        .patch(`/v1/access/users/${id}`)
        .send({
          roleIds: [viewer],
          roleExpiresAt: {
            [viewer]: new Date(Date.now() - 1000).toISOString(),
          },
        })
        .expect(400);
    });

    it('authenticates an API client by its key, and refuses an altered one', async () => {
      const client = await node.client();
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', client.auth)
        .expect(200);
      const altered =
        client.key.slice(0, -1) + (client.key.endsWith('A') ? 'B' : 'A');
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', `Bearer ${altered}`)
        .expect(401);
    });

    it('stops a rotated key at once, and a revoked client on its next request', async () => {
      const client = await node.client();
      const rotated = await node
        .admin()
        .post(`/v1/access/clients/${client.id}/rotate`)
        .expect(200);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', client.auth)
        .expect(401);
      const newAuth = `Bearer ${rotated.body.key}`;
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', newAuth)
        .expect(200);

      await node
        .admin()
        .patch(`/v1/access/clients/${client.id}`)
        .send({ active: false })
        .expect(200);
      await node
        .http()
        .get('/v1/test-items')
        .set('Authorization', newAuth)
        .expect(401);
    });

    it('never lists a key or its hash', async () => {
      await node.client('Listed');
      const listed = await node.admin().get('/v1/access/clients').expect(200);
      expect(listed.body.items[0]).not.toHaveProperty('key');
      expect(listed.body.items[0]).not.toHaveProperty('keyHash');
    });

    it('keeps API clients out of the user-only routes: a key is no session', async () => {
      const client = await node.client();
      await node
        .http()
        .get('/v1/access/roles')
        .set('Authorization', client.auth)
        .expect(401);
    });
  });
});
