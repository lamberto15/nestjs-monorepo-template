import { ConfigService } from '@nestjs/config';
import { iamEnv } from '../src/iam/iam.env.js';
import { bootApp, totp, type TestApp } from './support.js';

/**
 * IMPERSONATION, AUTH_MFA and API_CLIENTS (docs/auth.md, "Switches"). The
 * suite runs with them on (setup-env.ts); a test turns one off while the
 * app runs, so state made while it was on (a session, an authenticator, a
 * key) meets the switch off.
 */
describe('IAM deployment switches (e2e)', () => {
  let node: TestApp;
  let off: string[];

  beforeAll(async () => {
    node = await bootApp();
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

  it('defaults: impersonation off, two-factor and API clients on', () => {
    expect(iamEnv.parse({})).toMatchObject({
      IMPERSONATION: false,
      AUTH_MFA: true,
      API_CLIENTS: true,
    });
  });

  it('IMPERSONATION=off refuses the routes and ends a running impersonation', async () => {
    const user = await node.user(['editor']);
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    await admin.post(`/v1/access/users/${user.id}/impersonate`).expect(204);
    await admin.get('/v1/auth/me').expect(200);

    off = ['IMPERSONATION'];
    await admin.get('/v1/auth/me').expect(401);
    await admin.post('/v1/auth/impersonation/stop').expect(401);

    const fresh = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    const refused = await fresh
      .post(`/v1/access/users/${user.id}/impersonate`)
      .expect(404);
    expect(refused.body).toMatchObject({ code: 'feature_off' });
    await fresh.post('/v1/auth/impersonation/stop').expect(404);
    // A caller that isn't signed in learns nothing.
    await node
      .http()
      .post(`/v1/access/users/${user.id}/impersonate`)
      .expect(401);
    // Everything else about users is as before.
    await fresh.get('/v1/auth/me').expect(200);
  });

  it('AUTH_MFA=off refuses enrollment, and still asks enrolled users for a code', async () => {
    const enrolled = await node.user([]);
    const enrollment = await enrolled.agent
      .post('/v1/auth/mfa/enroll')
      .expect(200);
    await enrolled.agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: totp(enrollment.body.secret) })
      .expect(200);
    const other = await node.user([]);

    off = ['AUTH_MFA'];
    const refused = await other.agent.post('/v1/auth/mfa/enroll').expect(404);
    expect(refused.body).toMatchObject({ code: 'feature_off' });
    await other.agent
      .post('/v1/auth/mfa/confirm')
      .send({ code: '123456' })
      .expect(404);
    // The status stays readable, and the enrolled account is still asked.
    await enrolled.agent
      .get('/v1/auth/mfa')
      .expect(200)
      .expect((res) => expect(res.body.enabled).toBe(true));
    const signedIn = await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email: enrolled.email, password: enrolled.password })
      .expect(200);
    expect(signedIn.body).toEqual({ signedIn: false, mfaRequired: true });
    const token = await node
      .http()
      .post('/v1/auth/token')
      .send({ email: enrolled.email, password: enrolled.password })
      .expect(401);
    expect(JSON.stringify(token.body)).toContain('mfa_required');
  });

  it('API_CLIENTS=off refuses the routes and the keys, not the users', async () => {
    const client = await node.client();
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    await node
      .http()
      .get('/v1/usage')
      .set('Authorization', client.auth)
      .expect(200);

    off = ['API_CLIENTS'];
    await node
      .http()
      .get('/v1/usage')
      .set('Authorization', client.auth)
      .expect(401);
    const list = await admin.get('/v1/access/clients').expect(404);
    expect(list.body).toMatchObject({ code: 'feature_off' });
    await admin.post('/v1/access/clients').send({ name: 'x' }).expect(404);
    await admin.post(`/v1/access/clients/${client.id}/rotate`).expect(404);
    await admin
      .patch(`/v1/access/clients/${client.id}`)
      .send({ active: false })
      .expect(404);
    await admin.get(`/v1/access/clients/${client.id}/usage`).expect(404);
    await admin.get('/v1/auth/me').expect(200);

    // Back on: the same key works again.
    off = [];
    await node
      .http()
      .get('/v1/usage')
      .set('Authorization', client.auth)
      .expect(200);
  });
});
