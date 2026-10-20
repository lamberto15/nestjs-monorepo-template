import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { tenants } from '../src/core/tenancy/tenancy.tables.js';
import { SignUpTenantSweepJob } from '../src/iam/access/sign-up-tenant-sweep.job.js';
import { OidcAccounts } from '../src/iam/account/account.handlers.js';
import { emailTokens, roles, users } from '../src/iam/iam.tables.js';
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

  it('audits a provider sign-up’s tenant with the callback request’s address', async () => {
    const address = email();
    const cls = node.app.get(ClsService);
    const created = await cls.run(async () => {
      cls.set(CLS_REQ, { ip: '203.0.113.7' });
      return node.app.get(OidcAccounts).resolveUser(
        {
          provider: 'google',
          subject: randomUUID(),
          email: address,
          emailVerified: true,
          name: 'Grace Hopper',
        } as never,
        {} as never,
        {} as never,
      );
    });
    expect(created).toMatchObject({ id: expect.any(String) });
    const [entry] = await node.auditEntries({
      action: 'tenant.created',
      actor: `user:${created!.id}`,
    });
    expect(entry).toMatchObject({
      ip: '203.0.113.7',
      details: { via: 'sign-up' },
    });
    const [signedUp] = await node.auditEntries({
      action: 'user.signed-up',
      targetId: created!.id,
    });
    expect(signedUp).toMatchObject({ ip: '203.0.113.7' });
  });

  describe('the sweep of unverified sign-ups’ tenants', () => {
    /** Signs up without proving the address: the tenant's id and the account's. */
    const unverified = async (tenantName: string) => {
      const address = email();
      await node
        .http()
        .post('/v1/auth/sign-up')
        .send({
          email: address,
          name: 'Bot',
          password: newPassword(),
          tenantName,
        })
        .expect(201);
      const [tenant] = await node.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.name, tenantName));
      const [user] = await node.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, address));
      return { tenantId: tenant!.id, userId: user!.id, address };
    };
    /** Makes a tenant, and its accounts' links, look `days` old. */
    const age = async (tenantId: string, days: number, userId?: string) => {
      const then = sql`now() - make_interval(days => ${days})`;
      await node.db
        .update(tenants)
        .set({ createdAt: then as never })
        .where(eq(tenants.id, tenantId));
      if (userId) {
        await node.db
          .update(emailTokens)
          .set({
            expiresAt: sql`now() - make_interval(days => ${days - 1})` as never,
          })
          .where(eq(emailTokens.userId, userId));
      }
    };
    const exists = async (tenantId: string) =>
      (
        await node.db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
      ).length === 1;

    it('deletes a sign-up’s tenant nobody verified past the grace, audited outside any tenant, and keeps the rest', async () => {
      const stale = await unverified(`Stale ${randomUUID()}`);
      await age(stale.tenantId, 9, stale.userId);
      // Unverified, but a link resent lately still works.
      const resent = await unverified(`Resent ${randomUUID()}`);
      await age(resent.tenantId, 9);
      // Unverified, and recent.
      const recent = await unverified(`Recent ${randomUUID()}`);
      // Verified: its owner uses it.
      const owner = await signUp({ tenantName: `Used ${randomUUID()}` });
      const used = (await owner.get('/v1/auth/me').expect(200)).body.tenant
        .id as string;
      await age(used, 9);
      // Made by the operators, its administrator still invited: never a sign-up's.
      const other = await node.otherTenant();
      await age(other.id, 9);

      const deleted = await node.app.get(SignUpTenantSweepJob).run();
      expect(deleted).toBe(1);

      expect(await exists(stale.tenantId)).toBe(false);
      for (const id of [resent.tenantId, recent.tenantId, used, other.id]) {
        expect(await exists(id)).toBe(true);
      }
      // Its rows went with it (the database's cascade), past row-level security.
      const left = await node.db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.tenantId, stale.tenantId));
      expect(left).toEqual([]);
      // The account stays, unverified, in no tenant.
      const [account] = await node.db
        .select({ verified: users.emailVerified })
        .from(users)
        .where(eq(users.id, stale.userId));
      expect(account).toEqual({ verified: false });

      const [entry] = await node.auditEntries({
        action: 'tenant.purged',
        targetId: stale.tenantId,
      });
      expect(entry).toMatchObject({
        tenantId: null,
        actor: 'system:sign-up-tenant-sweep',
        details: { reason: 'sign-up-unverified', members: [stale.userId] },
      });
      // Nothing left to do: a second run deletes nothing.
      expect(await node.app.get(SignUpTenantSweepJob).run()).toBe(0);
    });
  });
});
