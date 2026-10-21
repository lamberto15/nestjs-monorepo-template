import { ModeService } from '../src/platform/mode/mode.service.js';
import { bootApp, type TestApp } from './support.js';

/**
 * `platform.mode` (docs/settings.md, "Maintenance and read-only mode"): the
 * operators set it with PUT /v1/settings/platform.mode/platform; read-only
 * refuses writes, maintenance refuses everything but health, sign-in, the
 * features and the operators' routes; the operators can always turn it off.
 */
describe('maintenance and read-only mode (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  const setMode = async (value: string) => {
    await node
      .admin()
      .put('/v1/settings/platform.mode/platform')
      .send({ value })
      .expect(200);
    await node.app.get(ModeService).refresh();
  };
  afterEach(async () => {
    await node.admin().delete('/v1/settings/platform.mode/platform');
    await node.app.get(ModeService).refresh();
  });

  it('is normal by default and shown in /v1/features', async () => {
    const features = await node.admin().get('/v1/features').expect(200);
    expect(features.body.mode).toBe('normal');
  });

  it('read-only: reads work, writes answer 503 read_only with Retry-After', async () => {
    const user = await node.user(['editor']);
    await setMode('read-only');
    const features = await node.admin().get('/v1/features').expect(200);
    expect(features.body.mode).toBe('read-only');
    await user.agent.get('/v1/auth/me').expect(200);
    const refused = await node.writeItem(user.agent).expect(503);
    expect(refused.body).toMatchObject({ code: 'read_only' });
    expect(refused.headers['retry-after']).toBeDefined();
    await node.http().get('/health/live').expect(200);
  });

  it('maintenance: everything but health, sign-in and the operators answers 503', async () => {
    const user = await node.user(['editor']);
    await setMode('maintenance');
    const refused = await user.agent.get('/v1/test-items').expect(503);
    expect(refused.body).toMatchObject({ code: 'maintenance' });
    expect(refused.headers['retry-after']).toBeDefined();
    await node.http().get('/health/live').expect(200);
    await node.signIn(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
    await node.admin().get('/v1/ops/queues').expect(200);
    // The operators turn it off again.
    await node
      .admin()
      .put('/v1/settings/platform.mode/platform')
      .send({ value: 'normal' })
      .expect(200);
    await node.app.get(ModeService).refresh();
    await user.agent.get('/v1/test-items').expect(200);
  });

  it('every way to sign in keeps working, and tokens renew: the operators can always get back in', async () => {
    const user = await node.user(['editor']);
    const credentials = { email: user.email, password: user.password };
    const issued = await node
      .http()
      .post('/v1/auth/token')
      .send(credentials)
      .expect(200);
    // A route that is not the mode's to answer: its own 4xx/2xx, never the 503.
    const notRefused = async (
      method: 'get' | 'post',
      path: string,
      body?: object,
    ) => {
      const res = await node.http()[method](path).send(body);
      expect(res.status, `${method} ${path}`).not.toBe(503);
    };
    let refreshToken = issued.body.refreshToken as string;
    for (const mode of ['read-only', 'maintenance']) {
      await setMode(mode);
      // Token clients: sign in, renew (single use: the next round uses the new one), sign out.
      await node.http().post('/v1/auth/token').send(credentials).expect(200);
      const renewed = await node
        .http()
        .post('/v1/auth/token/refresh')
        .send({ refreshToken })
        .expect(200);
      refreshToken = renewed.body.refreshToken;
      // Passkeys, OAuth/OIDC providers, SSO and a magic link already mailed.
      await notRefused('post', '/v1/auth/passkeys/sign-in/options', {});
      await notRefused('post', '/v1/auth/passkeys/sign-in', {});
      await notRefused('post', '/v1/auth/passkeys/token', {});
      await notRefused('get', '/v1/auth/oidc/google/login');
      await notRefused('get', '/v1/auth/oidc/google/callback');
      await notRefused('post', '/v1/auth/sso/discover', {
        email: 'someone@sso.example.com',
      });
      await notRefused(
        'get',
        '/v1/auth/sso/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000000/login',
      );
      await notRefused('post', '/v1/auth/magic-link/verify', {
        token: 'not-a-link',
      });
    }
    await node
      .http()
      .post('/v1/auth/token/revoke')
      .send({ refreshToken })
      .expect(204);
    // Asking for a link needs the mail queue, which is paused: refused.
    await setMode('maintenance');
    await node
      .http()
      .post('/v1/auth/magic-link')
      .send({ email: user.email })
      .expect(503);
  });

  it('a tenant cannot set the mode for itself, and a bad value is refused', async () => {
    await node
      .admin()
      .put('/v1/settings/platform.mode')
      .send({ value: 'maintenance' })
      .expect(400);
    await node
      .admin()
      .put('/v1/settings/platform.mode/platform')
      .send({ value: 'sleepy' })
      .expect(400);
  });
});
