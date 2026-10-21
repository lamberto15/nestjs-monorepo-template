import { bootApp, type TestApp } from './support.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
]);

/**
 * Tenant limits (docs/tenancy.md, "Quotas"): the operators set them per
 * tenant, creating past one answers 422 `quota_exceeded`, parallel requests
 * never pass the last place, and a tenant's administrators read their use.
 */
describe('tenant quotas (e2e)', () => {
  let node: TestApp;
  let other: Awaited<ReturnType<TestApp['otherTenant']>>;

  beforeAll(async () => {
    node = await bootApp();
    other = await node.otherTenant();
  });
  afterAll(() => node.close());

  const setQuotas = (body: Record<string, unknown>) =>
    node.admin().put(`/v1/tenants/${other.id}/quotas`).send(body);

  it('limits API clients, and parallel creates never pass the limit', async () => {
    await setQuotas({ maxApiClients: 2 }).expect(200);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        other.admin
          .post('/v1/access/clients')
          .send({ name: `parallel-${index}` }),
      ),
    );
    const statuses = results.map((res) => res.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 201, 422, 422, 422, 422]);
    const refused = results.find((res) => res.status === 422)!;
    expect(refused.body).toMatchObject({
      code: 'quota_exceeded',
      quota: { resource: 'apiClients', limit: 2, used: 2 },
    });
    // Raising it lets the next one in; removing it (null) lifts it.
    await setQuotas({ maxApiClients: 3 }).expect(200);
    await other.admin
      .post('/v1/access/clients')
      .send({ name: 'third' })
      .expect(201);
    await other.admin
      .post('/v1/access/clients')
      .send({ name: 'fourth' })
      .expect(422);
    await setQuotas({ maxApiClients: null }).expect(200);
    await other.admin
      .post('/v1/access/clients')
      .send({ name: 'fourth' })
      .expect(201);
  });

  it('limits the records of a feature', async () => {
    await setQuotas({ maxRecords: { TestItem: 1 } }).expect(200);
    await node.writeItem(other.admin, { title: 'one', body: 'x' }).expect(201);
    const refused = await node
      .writeItem(other.admin, { title: 'two', body: 'x' })
      .expect(422);
    expect(refused.body).toMatchObject({
      code: 'quota_exceeded',
      quota: { resource: 'records:TestItem', limit: 1, used: 1 },
    });
    await setQuotas({ maxRecords: { TestItem: null } }).expect(200);
  });

  it('limits stored bytes', async () => {
    const item = (
      await node
        .writeItem(other.admin, { title: 'files', body: 'x' })
        .expect(201)
    ).body as { id: string };
    await setQuotas({ maxStorageBytes: PNG.length * 2 }).expect(200);
    const upload = () =>
      other.admin
        .post(`/v1/test-items/${item.id}/attachments`)
        .attach('file', PNG, { filename: 'dot.png', contentType: 'image/png' });
    await upload().expect(201);
    await upload().expect(201);
    const refused = await upload().expect(422);
    expect(refused.body).toMatchObject({
      code: 'quota_exceeded',
      quota: { resource: 'storageBytes' },
    });
    await setQuotas({ maxStorageBytes: null }).expect(200);
  });

  it('limits members: an invitation can be sent, its acceptance takes the seat', async () => {
    const usage = (await other.admin.get('/v1/tenant/usage').expect(200)).body;
    await setQuotas({ maxMembers: usage.members.used }).expect(200);
    const email = `late-${Date.now()}@example.com`;
    const token = await node.invite(other.admin, { email, name: email });
    const accepted = await node
      .http()
      .post('/v1/auth/invitations/accept')
      .send({ token, password: 'a-long-enough-passphrase-1!' });
    expect(accepted.status).toBe(422);
    expect(accepted.body.code).toBe('quota_exceeded');
    await setQuotas({ maxMembers: null }).expect(200);
  });

  it('shows the use and the limits, to the operators and to the tenant', async () => {
    await setQuotas({ maxStorageBytes: 1_000_000 }).expect(200);
    const operators = (
      await node.admin().get(`/v1/tenants/${other.id}/usage`).expect(200)
    ).body;
    const own = (await other.admin.get('/v1/tenant/usage').expect(200)).body;
    expect(own).toEqual(operators);
    expect(own.storageBytes.limit).toBe(1_000_000);
    expect(own.members.used).toBeGreaterThanOrEqual(1);
    expect(own.limits).toMatchObject({ maxStorageBytes: 1_000_000 });
    expect(own.records).toHaveProperty('TestItem');
  });

  it('is the operators’ to set, and audited in the tenant', async () => {
    const body = { maxMembers: 5 };
    const refused = await other.admin
      .put(`/v1/tenants/${other.id}/quotas`)
      .send(body)
      .expect(403);
    expect(refused.body.code).toBe('operator_required');
    await other.admin.get(`/v1/tenants/${other.id}/usage`).expect(403);
    await setQuotas({ maxMembers: 5 }).expect(200);
    const entries = await node.auditEntries({
      action: 'tenant.quotas-changed',
    });
    expect(entries.length).toBeGreaterThan(0);
    // Unknown fields are refused.
    await setQuotas({ maxWidgets: 1 }).expect(400);
    await node
      .admin()
      .put(`/v1/tenants/00000000-0000-4000-8000-000000000000/quotas`)
      .send(body)
      .expect(404);
  });

  it('takes its default from the platform settings', async () => {
    await setQuotas({ maxApiClients: null }).expect(200);
    await node
      .admin()
      .put('/v1/settings/quotas.maxApiClients/platform')
      .send({ value: 0 })
      .expect(200);
    try {
      await other.admin
        .post('/v1/access/clients')
        .send({ name: 'by-default' })
        .expect(422);
      // The tenant's own limit wins over the default.
      await setQuotas({ maxApiClients: 100 }).expect(200);
      await other.admin
        .post('/v1/access/clients')
        .send({ name: 'by-default' })
        .expect(201);
    } finally {
      await node
        .admin()
        .delete('/v1/settings/quotas.maxApiClients/platform')
        .expect(204);
    }
  });
});
