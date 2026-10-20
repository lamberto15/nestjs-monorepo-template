import request from 'supertest';
import { pageSchema } from '../src/core/http/pagination.js';
import { signInEntrySchema } from '../src/iam/access/access.schemas.js';
import { SignInLog } from '../src/iam/account/sign-in-log.service.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The tenant's sign-in log (GET /v1/access/sign-ins, GET /v1/lists/SignIn,
 * #228): its administrators see their members' sign-ins and wrong
 * passwords, filtered by user, method and result, and nobody else's.
 */
describe('sign-in log (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const signIns = async (
    agent: request.Agent,
    query: Record<string, string> = {},
  ) =>
    pageSchema(signInEntrySchema.strict()).parse(
      (await agent.get('/v1/access/sign-ins').query(query).expect(200)).body,
    ).items;

  /** A wrong secret for `email`, answered 401 and logged after the answer. */
  async function refusedSignIn(email: string) {
    await request(node.app.getHttpServer())
      .post('/v1/auth/sign-in')
      .send({ email, password: `wrong-${Date.now()}-Zq9!` })
      .expect(401);
    await node.app.get(SignInLog).settled();
  }

  it("shows the tenant its members' sign-ins and refusals, filtered", async () => {
    const ada = await node.user(['editor']);
    const bob = await node.user(['editor']);
    await refusedSignIn(ada.email);

    const all = await signIns(node.admin());
    expect(all.filter((entry) => entry.user === `user:${ada.id}`)).toEqual([
      expect.objectContaining({
        result: 'failure',
        method: 'password',
        userLabel: ada.email,
      }),
      expect.objectContaining({
        result: 'success',
        method: 'password',
        userLabel: ada.email,
      }),
    ]);

    expect(
      await signIns(node.admin(), { user: `user:${bob.id}` }),
    ).toMatchObject([{ result: 'success', user: `user:${bob.id}` }]);
    const failures = await signIns(node.admin(), { result: 'failure' });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((entry) => entry.result === 'failure')).toBe(true);
    expect(await signIns(node.admin(), { method: 'magic-link' })).toEqual([]);
    expect(
      (await signIns(node.admin(), { 'method.in': 'password,passkey' })).length,
    ).toBe(all.length);
  });

  it("keeps another tenant's sign-ins from this one, and this one's from theirs", async () => {
    const other = await node.otherTenant();
    const theirs = await other.user(['editor']);
    const ours = await node.user(['editor']);
    await refusedSignIn(theirs.email);

    const mine = (await signIns(node.admin())).map((e) => e.userLabel);
    expect(mine).not.toContain(theirs.email);
    expect(mine).toContain(ours.email);

    const seen = await signIns(other.admin);
    const labels = seen.map((entry) => entry.userLabel);
    expect(labels).toContain(theirs.email);
    expect(labels).not.toContain(ours.email);
    expect(seen.filter((entry) => entry.result === 'failure')).toHaveLength(1);
  });

  it('logs nothing of an unknown address, and only an administrator reads it', async () => {
    await refusedSignIn('nobody-here@example.com');
    const all = await signIns(node.admin());
    expect(all.map((entry) => entry.userLabel)).not.toContain(
      'nobody-here@example.com',
    );

    const viewer = await node.user(['viewer']);
    await viewer.agent.get('/v1/access/sign-ins').expect(403);
    await request(node.app.getHttpServer())
      .get('/v1/access/sign-ins')
      .expect(401);
  });

  it('is described by GET /v1/lists/SignIn', async () => {
    const described = (await node.admin().get('/v1/lists/SignIn').expect(200))
      .body as { fields: { name: string }[] };
    expect(described.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(['user', 'method', 'result', 'at']),
    );
    const viewer = await node.user(['viewer']);
    await viewer.agent.get('/v1/lists/SignIn').expect(403);
  });
});
