import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { Database } from '../src/core/database/drizzle.js';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { readOnlyTenantScope } from '../src/core/tenancy/tenant-scope.js';
import { auditLog, breakGlassGrants, users } from '../src/iam/iam.tables.js';
import { OutboxRelay } from '@nestjs/outbox';
import { bootApp, type TestApp } from './support.js';

/**
 * Break-glass (docs/tenancy.md, "Break-glass"): an operator reads a tenant
 * that never invited them, read only (the database refuses any write), for
 * an hour at most, with a reason kept in both tenants' audit logs and told
 * to the tenant's administrators at once (a notification, the sign-in
 * log). Only with Platform.breakGlass in the operator tenant; a tenant
 * opts out with `auth.allowBreakGlass: false`.
 */
describe('break-glass (e2e)', () => {
  let node: TestApp;
  let other: Awaited<ReturnType<TestApp['otherTenant']>>;

  beforeEach(async () => {
    node = await bootApp();
    other = await node.otherTenant();
  });
  afterEach(() => node.close());

  const open = (reason = 'Incident 42: their invoices fail to load') =>
    node.admin().post(`/v1/tenants/${other.id}/break-glass`).send({ reason });

  it('opens a tenant read only, audited in both tenants, told to its administrators, in its sign-in log', async () => {
    await node
      .writeItem(other.admin, { title: 'Theirs', body: 'Private' })
      .expect(201);
    // Without a grant, the operator sees nothing of it.
    const own = await node.admin().get('/v1/test-items').expect(200);
    expect(own.body.items).toEqual([]);

    const before = Date.now();
    const res = await open().expect(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      tenantId: other.id,
      reason: 'Incident 42: their invoices fail to load',
      endedAt: null,
    });
    const expiresAt = Date.parse(res.body.expiresAt as string);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    const grant = res.body.id as string;

    const read = await node
      .admin()
      .get('/v1/test-items')
      .set('Break-Glass', grant)
      .expect(200);
    expect(read.body.items).toEqual([
      expect.objectContaining({ title: 'Theirs' }),
    ]);
    const me = await node
      .admin()
      .get('/v1/auth/me')
      .set('Break-Glass', grant)
      .expect(200);
    expect(me.body.tenant).toMatchObject({ id: other.id, operator: false });
    // The operators' routes stay theirs: not from inside the other tenant.
    await node.admin().get('/v1/tenants').set('Break-Glass', grant).expect(403);

    // Audited with the reason, in the operators' tenant and in that one.
    const entries = await node.auditEntries({
      action: 'tenant.break-glass-started',
      targetId: other.id,
    });
    expect(new Set(entries.map((entry) => entry.tenantId))).toEqual(
      new Set([node.tenantId, other.id]),
    );
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.details).toMatchObject({
        grantId: grant,
        reason: 'Incident 42: their invoices fail to load',
      });
    }
    const theirLog = await other.admin
      .get('/v1/access/audit')
      .query({ action: 'tenant.break-glass-started' })
      .expect(200);
    expect(theirLog.body.items).toHaveLength(1);

    // In their sign-in log.
    const signIns = await other.admin
      .get('/v1/access/sign-ins')
      .query({ method: 'break-glass' })
      .expect(200);
    expect(signIns.body.items).toEqual([
      expect.objectContaining({
        method: 'break-glass',
        result: 'success',
        userLabel: process.env.ADMIN_EMAIL,
      }),
    ]);

    // Their administrator is told at once, in the app and by mail.
    const notifications = await other.admin
      .get('/v1/notifications')
      .expect(200);
    expect(notifications.body.items).toEqual([
      expect.objectContaining({
        type: 'security.breakGlassStarted',
        data: expect.objectContaining({
          operator: process.env.ADMIN_EMAIL,
          reason: 'Incident 42: their invoices fail to load',
        }),
      }),
    ]);
    await node.app.get(OutboxRelay).runOnce();
    const mail = await node.waitForMail({
      to: other.email,
      subject: /break-glass/i,
    });
    expect(mail.text ?? mail.html).toContain('Incident 42');
  });

  it('refuses writes: in the guard, and in the database itself', async () => {
    const grant = (await open().expect(201)).body.id as string;
    await node
      .writeItem(other.admin, { title: 'Theirs', body: 'Private' })
      .expect(201);
    const write = node
      .admin()
      .post('/v1/test-items')
      .set('Break-Glass', grant)
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Mine', body: 'Planted' });
    await write
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_read_only'));
    await node
      .admin()
      .post('/v1/access/roles')
      .set('Break-Glass', grant)
      .send({ name: 'Planted', permissions: [] })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_read_only'));

    // The scope a break-glass request runs in: every transaction READ ONLY,
    // a tenant table's write and a global table's alike (25006).
    const db = node.app.get<Database>(getDrizzleToken());
    const tenancy = node.app.get(Tenancy);
    const readOnly = <T>(work: () => Promise<T>) =>
      tenancy.run(readOnlyTenantScope(other.id), work);
    await expect(
      readOnly(() =>
        db.insert(auditLog).values({
          actor: 'anonymous',
          actorLabel: 'anonymous',
          action: 'planted',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '25006' } });
    await expect(
      readOnly(() =>
        db
          .update(users)
          .set({ name: 'Planted' })
          .where(eq(users.email, other.email)),
      ),
    ).rejects.toMatchObject({ cause: { code: '25006' } });
    await expect(
      readOnly(() => db.transaction((tx) => tx.execute(sql`select 1`))),
    ).resolves.toBeDefined();
    // Reads work, in that tenant only.
    const rows = await readOnly(() =>
      db.select().from(auditLog).where(eq(auditLog.action, 'planted')),
    );
    expect(rows).toEqual([]);
    const items = await node
      .admin()
      .get('/v1/test-items')
      .set('Break-Glass', grant)
      .expect(200);
    expect(items.body.items).toHaveLength(1);
  });

  it('expires after its time, is never renewed, and ends early', async () => {
    const grant = (await open().expect(201)).body.id as string;
    // A second grant while this one runs: no renewal.
    await open('Still incident 42, a bit longer please')
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('break_glass_active'));
    // At most an hour.
    await node
      .admin()
      .post(`/v1/tenants/${other.id}/break-glass`)
      .send({ reason: 'Incident 42, all day', minutes: 61 })
      .expect(400);

    // Its hour is up.
    await node.db
      .update(breakGlassGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(breakGlassGrants.id, grant));
    await node
      .admin()
      .get('/v1/test-items')
      .set('Break-Glass', grant)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_expired'));

    // A new one needs a new reason; ended early, it stops at once.
    const next = await open('Incident 43: exports stuck').expect(201);
    await node
      .admin()
      .get('/v1/test-items')
      .set('Break-Glass', next.body.id as string)
      .expect(200);
    const ended = await node
      .admin()
      .delete(`/v1/tenants/${other.id}/break-glass/${next.body.id}`)
      .expect(200);
    expect(ended.body.endedAt).toEqual(expect.any(String));
    await node
      .admin()
      .get('/v1/test-items')
      .set('Break-Glass', next.body.id as string)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_invalid'));
    const endedEntries = await node.auditEntries({
      action: 'tenant.break-glass-ended',
      targetId: other.id,
    });
    expect(new Set(endedEntries.map((entry) => entry.tenantId))).toEqual(
      new Set([node.tenantId, other.id]),
    );
    expect(endedEntries).toHaveLength(2);
    const listed = await node
      .admin()
      .get(`/v1/tenants/${other.id}/break-glass`)
      .expect(200);
    expect(listed.body.items).toHaveLength(2);
  });

  it('is refused without Platform.breakGlass in the operator tenant', async () => {
    // A member of the operator tenant without the permission.
    const editor = await node.user(['editor']);
    await editor.agent
      .post(`/v1/tenants/${other.id}/break-glass`)
      .send({ reason: 'I would like to have a look' })
      .expect(403);
    // Another tenant's administrator: every permission there, no operator.
    const third = await node.otherTenant();
    await third.admin
      .post(`/v1/tenants/${other.id}/break-glass`)
      .send({ reason: 'I would like to have a look' })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('operator_required'));
    // Someone else's grant, or none, opens nothing.
    const grant = (await open().expect(201)).body.id as string;
    await editor.agent
      .get('/v1/test-items')
      .set('Break-Glass', grant)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_invalid'));
    await third.admin
      .get('/v1/test-items')
      .set('Break-Glass', grant)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_invalid'));
    await node
      .admin()
      .get('/v1/test-items')
      .set('Break-Glass', 'not-a-grant')
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_invalid'));
    // Never into the operators' own tenant.
    await node
      .admin()
      .post(`/v1/tenants/${node.tenantId}/break-glass`)
      .send({ reason: 'Looking at our own tenant' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('break_glass_own_tenant'));
    // A reason is required.
    await node
      .admin()
      .post(`/v1/tenants/${other.id}/break-glass`)
      .send({})
      .expect(400);
  });

  it("stops at the tenant's opt-out, new grants and running ones", async () => {
    const grant = (await open().expect(201)).body.id as string;
    await other.admin
      .put('/v1/settings/auth.allowBreakGlass')
      .send({ value: false })
      .expect(200);
    await node
      .admin()
      .get('/v1/test-items')
      .set('Break-Glass', grant)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_disabled'));
    await node
      .admin()
      .delete(`/v1/tenants/${other.id}/break-glass/${grant}`)
      .expect(200);
    await open('Incident 44: they opted out meanwhile')
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('break_glass_disabled'));
  });
});
