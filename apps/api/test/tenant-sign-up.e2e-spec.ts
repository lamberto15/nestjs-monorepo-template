import { randomUUID } from 'node:crypto';
import { bootApp, newPassword, type TestApp } from './support.js';

// Read when AppModule loads: a multi-tenant deployment whose sign-ups make tenants.
vi.hoisted(() => {
  process.env.AUTH_SIGN_UP = 'on';
  process.env.TENANT_SIGN_UP = 'on';
});

/**
 * TENANT_SIGN_UP (docs/tenancy.md, "Tenants made at sign-up"): a self
 * sign-up makes its own tenant, the new account its administrator, behind
 * the same wall as every tenant; the slug is drawn, never chosen. Off is
 * sign-up.e2e-spec.ts (no tenant), TENANCY=single single-tenant.e2e-spec.ts
 * (the switch ignored: sign-ups join the one tenant).
 */
describe('TENANT_SIGN_UP=on (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  const email = () => `${randomUUID().slice(0, 8)}@example.com`;
  const tenantCount = async () =>
    (await node.admin().get('/v1/tenants?count=true').expect(200)).body
      .total as number;
  /** Signs up, proves the address, signs in: the new account's browser. */
  const signUp = async (body: Record<string, unknown> = {}) => {
    const address = email();
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: address, name: 'Ada Lovelace', password, ...body })
      .expect(201);
    await node.verifySignUp(address, password);
    return node.signIn(address, password);
  };

  it('says so on the sign-in page', async () => {
    const methods = await node.http().get('/v1/auth/methods').expect(200);
    expect(methods.body).toMatchObject({ signUp: true, tenantSignUp: true });
  });

  it('makes a tenant whose first administrator is the new account, audited in it', async () => {
    const before = await tenantCount();
    const owner = await signUp({ tenantName: 'Acme Corp' });

    const me = await owner.get('/v1/auth/me').expect(200);
    expect(me.body.tenant).toMatchObject({
      name: 'Acme Corp',
      operator: false,
    });
    expect(me.body.tenant.slug).toMatch(/^acme-corp-[a-z0-9]{6}$/);
    const tenantId = me.body.tenant.id as string;
    expect(tenantId).not.toBe(node.tenantId);
    expect(me.body.user.tenantId).toBe(tenantId);
    expect(me.body.can['Access.manageRoles']).toBe(true);
    const mine = await owner.get('/v1/auth/tenants').expect(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ id: tenantId, current: true }),
    ]);
    // Its roles were seeded, and the account holds Administrator.
    const roles = await owner.get('/v1/access/roles').expect(200);
    expect(roles.body.items.map((r: { key: string }) => r.key)).toContain(
      'administrator',
    );
    expect(await tenantCount()).toBe(before + 1);

    const [created] = await node.auditEntries({
      action: 'tenant.created',
      targetId: tenantId,
    });
    expect(created).toMatchObject({
      tenantId,
      actor: `user:${me.body.user.id}`,
      details: { slug: me.body.tenant.slug, via: 'sign-up' },
    });
  });

  it('walls the new tenant off: it sees no other tenant’s rows, nor any operator route', async () => {
    await node.writeItem(node.admin()).expect(201);
    const owner = await signUp({ tenantName: 'Walled' });
    const theirs = await owner.get('/v1/test-items').expect(200);
    expect(theirs.body.items).toEqual([]);
    const written = await node.writeItem(owner).expect(201);
    const seeded = await node.admin().get('/v1/test-items').expect(200);
    expect(seeded.body.items.map((i: { id: string }) => i.id)).not.toContain(
      written.body.id,
    );
    // An administrator of their own tenant, never an operator.
    const refused = await owner.get('/v1/tenants').expect(403);
    expect(refused.body.code).toBe('operator_required');
    await owner
      .post('/v1/tenants')
      .send({ name: 'More', slug: 'more', administratorEmail: email() })
      .expect(403);
  });

  it('names the tenant after the person without a tenantName, and draws a new slug for a name taken', async () => {
    const first = await signUp();
    const second = await signUp();
    const [a, b] = await Promise.all(
      [first, second].map(
        async (agent) =>
          (await agent.get('/v1/auth/me').expect(200)).body.tenant,
      ),
    );
    expect(a.name).toBe('Ada Lovelace');
    expect(b.name).toBe('Ada Lovelace');
    expect(a.slug).toMatch(/^ada-lovelace-[a-z0-9]{6}$/);
    expect(b.slug).not.toBe(a.slug);
    expect(b.id).not.toBe(a.id);
  });

  it('leaves no tenant behind when the account is refused', async () => {
    const address = email();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: address, name: 'Ada', password: newPassword() })
      .expect(201);
    const before = await tenantCount();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({
        email: address,
        name: 'Ada',
        password: newPassword(),
        tenantName: 'Again',
      })
      .expect(409);
    expect(await tenantCount()).toBe(before);
  });

  it('keeps an unproved sign-up out of its tenant until the address is proved', async () => {
    const address = email();
    const password = newPassword();
    await node
      .http()
      .post('/v1/auth/sign-up')
      .send({ email: address, name: 'Ada', password, tenantName: 'Pending' })
      .expect(201);
    const refused = await node
      .http()
      .post('/v1/auth/sign-in')
      .send({ email: address, password })
      .expect(403);
    expect(refused.body.code).toBe('email_unverified');
  });
});
