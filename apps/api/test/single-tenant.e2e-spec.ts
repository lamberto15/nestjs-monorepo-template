import { randomUUID } from 'node:crypto';
import { bootApp, newPassword, type TestApp } from './support.js';

// Read when AppModule loads: a single-tenant deployment with open sign-up.
vi.hoisted(() => {
  process.env.TENANCY = 'single';
  process.env.AUTH_SIGN_UP = 'on';
  process.env.SIGN_UP_ROLES = 'editor';
});

/**
 * TENANCY=single (docs/tenancy.md, "Single-tenant deployments"): the first
 * start's tenant is the only one, and a self sign-up joins it with
 * SIGN_UP_ROLES, so it acts in the tenant from its first sign-in.
 */
describe('single-tenant deployment (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  it('makes a sign-up a member of the tenant, with SIGN_UP_ROLES, audited', async () => {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email, name: 'Ada', password })
      .expect(201);
    await node.verifySignUp(email, password);
    const member = await node.signIn(email, password);

    const me = await member.get('/v1/auth/me').expect(200);
    expect(me.body.user.tenantId).toBe(node.tenantId);
    const mine = await member.get('/v1/auth/tenants').expect(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ id: node.tenantId, current: true }),
    ]);
    // Editor: test items of their own, in the tenant.
    await node.writeItem(member).expect(201);
    await member.get('/v1/test-items').expect(200);

    const [joined] = await node.auditEntries({
      action: 'user.joined',
      targetId: me.body.user.id,
    });
    expect(joined).toMatchObject({
      tenantId: node.tenantId,
      details: { via: 'sign-up' },
    });
  });

  it('refuses a second tenant', async () => {
    const res = await node
      .admin()
      .post('/v1/tenants')
      .send({
        name: 'Other',
        slug: 'other',
        administratorEmail: 'other-admin@example.com',
      })
      .expect(409);
    expect(res.body.code).toBe('single_tenant');
    const list = await node.admin().get('/v1/tenants').expect(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('reads, renames and lists its one tenant, which is the operators’ and is never deactivated', async () => {
    const me = await node.admin().get('/v1/auth/me').expect(200);
    expect(me.body.tenant).toMatchObject({ id: node.tenantId, operator: true });
    await node.admin().get(`/v1/tenants/${node.tenantId}`).expect(200);
    const renamed = await node
      .admin()
      .patch(`/v1/tenants/${node.tenantId}`)
      .send({ name: 'Acme' })
      .expect(200);
    expect(renamed.body).toMatchObject({ name: 'Acme', operator: true });
    await node
      .admin()
      .patch(`/v1/tenants/${node.tenantId}`)
      .send({ active: false })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('operator_tenant'));
    const list = await node.admin().get('/v1/tenants?count=true').expect(200);
    expect(list.body).toMatchObject({ nextCursor: null, total: 1 });
    await node.admin().get('/v1/lists/Tenant').expect(200);
  });
});
