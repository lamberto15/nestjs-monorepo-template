import { randomUUID } from 'node:crypto';
import { bootApp, connect, type TestApp } from './support.js';

/**
 * The operators' tenants (docs/tenancy.md, "Operators"): the operator flag
 * on /me, the paged list and its description, one tenant read and changed
 * (rename, slug, deactivation and what it does), the slug conflict on its
 * field, and the first administrator's invitation in the create's answer.
 * Every route only for the operator tenant's members with manageTenants.
 */
describe('tenants (e2e)', () => {
  let node: TestApp;
  let other: Awaited<ReturnType<TestApp['otherTenant']>>;

  beforeEach(async () => {
    node = await bootApp();
    other = await node.otherTenant();
  });
  afterEach(() => node.close());

  it('says on /me whether the tenant is the operator tenant', async () => {
    const mine = await node.admin().get('/v1/auth/me').expect(200);
    expect(mine.body.tenant).toMatchObject({
      id: node.tenantId,
      operator: true,
    });
    const theirs = await other.admin.get('/v1/auth/me').expect(200);
    expect(theirs.body.tenant).toMatchObject({
      id: other.id,
      operator: false,
    });
  });

  it('reads one tenant with an ETag, to the operators only', async () => {
    const res = await node.admin().get(`/v1/tenants/${other.id}`).expect(200);
    expect(res.body).toMatchObject({
      id: other.id,
      slug: other.slug,
      active: true,
      operator: false,
    });
    expect(res.headers.etag).toMatch(/^"/);
    await node
      .admin()
      .get(`/v1/tenants/${other.id}`)
      .set('If-None-Match', res.headers.etag as string)
      .expect(304);
    await node.admin().get(`/v1/tenants/${randomUUID()}`).expect(404);

    // Another tenant's administrator: every permission there, no operator.
    await other.admin
      .get(`/v1/tenants/${other.id}`)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('operator_required'));
    await other.admin
      .patch(`/v1/tenants/${other.id}`)
      .send({ name: 'Mine now' })
      .expect(403);
    // The operator tenant's member without manageTenants.
    const editor = await node.user(['editor']);
    await editor.agent.get(`/v1/tenants/${other.id}`).expect(403);
    await editor.agent
      .patch(`/v1/tenants/${other.id}`)
      .send({ name: 'Nope' })
      .expect(403);
  });

  it('renames a tenant and changes its slug, audited in both tenants, with If-Match', async () => {
    const read = await node.admin().get(`/v1/tenants/${other.id}`).expect(200);
    const slug = `renamed-${randomUUID().slice(0, 6)}`;
    const res = await node
      .admin()
      .patch(`/v1/tenants/${other.id}`)
      .set('If-Match', read.headers.etag as string)
      .send({ name: 'Renamed', slug })
      .expect(200);
    expect(res.body).toMatchObject({ id: other.id, name: 'Renamed', slug });

    // The tag it read is stale now.
    await node
      .admin()
      .patch(`/v1/tenants/${other.id}`)
      .set('If-Match', read.headers.etag as string)
      .send({ name: 'Again' })
      .expect(412)
      .expect(({ body }) => expect(body.code).toBe('precondition_failed'));

    const entries = await node.auditEntries({
      action: 'tenant.updated',
      targetId: other.id,
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.tenantId)).toEqual(
      expect.arrayContaining([node.tenantId, other.id]),
    );
    for (const entry of entries) {
      expect(entry.details).toEqual({
        name: { from: other.slug, to: 'Renamed' },
        slug: { from: other.slug, to: slug },
      });
    }
    const me = await other.admin.get('/v1/auth/me').expect(200);
    expect(me.body.tenant).toMatchObject({ name: 'Renamed', slug });

    await node
      .admin()
      .patch(`/v1/tenants/${other.id}`)
      .send({})
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('validation_failed'));
  });

  it('answers a taken slug on the field, at create and at change', async () => {
    const created = await node
      .admin()
      .post('/v1/tenants')
      .send({
        name: 'Same',
        slug: other.slug,
        administratorEmail: 'same@example.com',
      })
      .expect(409);
    expect(created.body).toMatchObject({
      code: 'tenant_slug_taken',
      errors: [{ path: 'slug', message: expect.any(String) }],
    });
    const third = await node.otherTenant();
    const changed = await node
      .admin()
      .patch(`/v1/tenants/${third.id}`)
      .send({ slug: other.slug })
      .expect(409);
    expect(changed.body).toMatchObject({
      code: 'tenant_slug_taken',
      errors: [{ path: 'slug' }],
    });
  });

  it('says the first administrator was invited, the same whether or not the address has an account', async () => {
    const existing = await node.user(['editor']);
    for (const email of [
      existing.email,
      `${randomUUID().slice(0, 8)}@example.com`,
    ]) {
      const slug = `t-${randomUUID().slice(0, 8)}`;
      const res = await node
        .admin()
        .post('/v1/tenants')
        .send({ name: slug, slug, administratorEmail: email })
        .expect(201);
      expect(res.body).toMatchObject({ slug, active: true, operator: false });
      expect(res.body.administrator).toEqual({
        email,
        status: 'invited',
        expiresAt: expect.any(String),
      });
    }
  });

  it('deactivates a tenant: its sessions end, its keys and connections stop; reactivating gives back its members and keys', async () => {
    const client = await other.client();
    await node
      .http()
      .get('/v1/test-items')
      .set('Authorization', client.auth)
      .expect(200);
    const socket = await connect(node, client.key);
    try {
      const gone = new Promise<string>((resolve) =>
        socket.once('disconnect', resolve),
      );
      const res = await node
        .admin()
        .patch(`/v1/tenants/${other.id}`)
        .send({ active: false })
        .expect(200);
      expect(res.body.active).toBe(false);
      expect(await gone).toBe('io server disconnect');
    } finally {
      socket.disconnect();
    }

    // The session in it ended; a new sign-in acts in no tenant (their only one is off).
    await other.admin.get('/v1/auth/me').expect(401);
    const again = await node.signIn(other.email, other.password);
    const me = await again.get('/v1/auth/me').expect(200);
    expect(me.body.tenant).toBeNull();
    expect(
      (await again.get('/v1/auth/tenants').expect(200)).body.items,
    ).toEqual([]);
    await node
      .http()
      .get('/v1/test-items')
      .set('Authorization', client.auth)
      .expect(401);
    const [entry] = await node.auditEntries({
      action: 'tenant.updated',
      targetId: other.id,
    });
    expect(entry!.details).toMatchObject({ active: { from: true, to: false } });
    // Still listed and read by the operators.
    expect(
      (await node.admin().get(`/v1/tenants/${other.id}`).expect(200)).body
        .active,
    ).toBe(false);

    await node
      .admin()
      .patch(`/v1/tenants/${other.id}`)
      .send({ active: true })
      .expect(200);
    // The ended session stays ended; a sign-in starts in the tenant again.
    await other.admin.get('/v1/auth/me').expect(401);
    const back = await node.signIn(other.email, other.password);
    expect(
      (await back.get('/v1/auth/me').expect(200)).body.tenant,
    ).toMatchObject({ id: other.id, operator: false });
    await back.get('/v1/access/users').expect(200);
    await node
      .http()
      .get('/v1/test-items')
      .set('Authorization', client.auth)
      .expect(200);
  });

  it('never deactivates the operator tenant', async () => {
    await node
      .admin()
      .patch(`/v1/tenants/${node.tenantId}`)
      .send({ active: false })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('operator_tenant'));
    // Renaming it is fine.
    await node
      .admin()
      .patch(`/v1/tenants/${node.tenantId}`)
      .send({ name: 'Operators' })
      .expect(200);
    const me = await node.admin().get('/v1/auth/me').expect(200);
    expect(me.body.tenant).toMatchObject({ name: 'Operators', operator: true });
  });

  it('pages, filters and sorts the list, which GET /v1/lists/Tenant describes to the operators', async () => {
    const third = await node.otherTenant();
    await node
      .admin()
      .patch(`/v1/tenants/${third.id}`)
      .send({ active: false })
      .expect(200);

    // Newest first, a cursor to the next page.
    const first = await node.admin().get('/v1/tenants?limit=2').expect(200);
    expect(first.body.items.map((tenant: { id: string }) => tenant.id)).toEqual(
      [third.id, other.id],
    );
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await node
      .admin()
      .get(`/v1/tenants?limit=2&cursor=${first.body.nextCursor}&count=true`)
      .expect(200);
    expect(
      second.body.items.map((tenant: { id: string }) => tenant.id),
    ).toEqual([node.tenantId]);
    expect(second.body).toMatchObject({ nextCursor: null, total: 3 });

    const inactive = await node
      .admin()
      .get('/v1/tenants?active=false')
      .expect(200);
    expect(
      inactive.body.items.map((tenant: { id: string }) => tenant.id),
    ).toEqual([third.id]);
    const bySlug = await node
      .admin()
      .get(`/v1/tenants?slug.contains=${other.slug.slice(2)}`)
      .expect(200);
    expect(
      bySlug.body.items.map((tenant: { id: string }) => tenant.id),
    ).toEqual([other.id]);
    const operators = await node
      .admin()
      .get('/v1/tenants?operator=true&fields=slug')
      .expect(200);
    expect(operators.body.items).toEqual([
      { id: node.tenantId, slug: expect.any(String) },
    ]);
    const slugsBy = async (sort: string) =>
      (
        (await node.admin().get(`/v1/tenants?sort=${sort}`).expect(200)).body
          .items as { slug: string }[]
      ).map((tenant) => tenant.slug);
    const ascending = await slugsBy('slug');
    expect(ascending).toHaveLength(3);
    expect(await slugsBy('-slug')).toEqual([...ascending].reverse());
    await node.admin().get('/v1/tenants?secret=1').expect(400);

    const { body } = await node.admin().get('/v1/lists/Tenant').expect(200);
    expect(body.subject).toBe('Tenant');
    expect(body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'name', sortable: true }),
        expect.objectContaining({ name: 'active', type: 'boolean' }),
        expect.objectContaining({ name: 'createdAt', type: 'datetime' }),
      ]),
    );
    expect(body.select).toEqual(expect.arrayContaining(['slug', 'operator']));
    await other.admin.get('/v1/lists/Tenant').expect(403);
    const editor = await node.user(['editor']);
    await editor.agent.get('/v1/lists/Tenant').expect(403);
    await other.admin.get('/v1/tenants').expect(403);
  });
});
