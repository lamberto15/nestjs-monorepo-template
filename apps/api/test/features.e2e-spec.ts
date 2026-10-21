import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: the platform switches are decided then.
vi.hoisted(() => {
  process.env.REPORTS = 'off';
  process.env.AUTH_SIGN_UP = 'on';
  process.env.TENANCY = 'single';
});

/** GET /v1/features: the switches as this deployment's routes see them. */
describe('GET /v1/features (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('tells a signed-in user which switches are on', async () => {
    const user = await node.user([]);
    const res = await user.agent.get('/v1/features').expect(200);
    expect(res.body).toEqual({
      realtime: true,
      webhooks: true,
      reports: false,
      usage: true,
      impersonation: true,
      mfa: true,
      mode: 'normal',
      apiClients: true,
      passkeys: true,
      signUp: true,
      magicLink: true,
      documents: false,
      presignedUploads: false,
      ai: false,
      exchangeRates: false,
      tenancy: 'single',
      locales: ['en', 'de', 'ar', 'zh', 'ms'],
    });
  });

  it('agrees with the routes: reports are off, so /v1/reports is absent', async () => {
    await node.admin().get('/v1/reports').expect(404);
    const res = await node.admin().get('/v1/features').expect(200);
    expect(res.body.reports).toBe(false);
  });

  it('answers an API client too', async () => {
    const client = await node.client();
    const res = await node
      .http()
      .get('/v1/features')
      .set('Authorization', client.auth)
      .expect(200);
    expect(res.body.reports).toBe(false);
  });

  it('needs a sign-in (401)', async () => {
    await node.http().get('/v1/features').expect(401);
  });
});
