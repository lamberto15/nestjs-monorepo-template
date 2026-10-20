import { bootApp, type TestApp } from './support.js';

// Read when AppModule loads: the route and its type are left out of the
// module graph then, as the deployment switches are. Production as Compose
// runs it: its https host, the passkeys switched off (their relying party
// is refused on localhost there).
vi.hoisted(() => {
  process.env.NODE_ENV = 'production';
  process.env.APP_URL = 'https://api.example.com';
  process.env.PASSKEYS = 'off';
  // Production takes the two-factor keys from the environment only.
  process.env.MFA_ENCRYPTION_KEYS ??= Buffer.alloc(32, 7).toString('base64');
});

/** POST /v1/notifications/test exists in development and tests only. */
describe('POST /v1/notifications/test in production (e2e)', () => {
  let node: TestApp;

  beforeAll(async () => {
    node = await bootApp();
  });
  afterAll(async () => {
    await node.close();
  });

  it('is a missing route (404), signed in or not', async () => {
    const user = await node.user(['editor']);
    const res = await user.agent.post('/v1/notifications/test').expect(404);
    expect(res.body.code).toBe('not_found');
    await node.http().post('/v1/notifications/test').expect(404);
  });

  it('is not in the OpenAPI document, nor is its type declared', async () => {
    const user = await node.user(['editor']);
    const types = await user.agent.get('/v1/notifications/types').expect(200);
    expect(
      types.body.items.map((item: { type: string }) => item.type),
    ).not.toContain('system.test');
    const doc = await node.http().get('/api-json').expect(200);
    expect(Object.keys(doc.body.paths)).toContain('/v1/notifications');
    expect(Object.keys(doc.body.paths)).not.toContain('/v1/notifications/test');
    // The rest of the notifications API is untouched.
    await user.agent.get('/v1/notifications').expect(200);
  });
});
