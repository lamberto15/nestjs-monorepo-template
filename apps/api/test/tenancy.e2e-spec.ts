import { TransactionHost } from '@nestjs-cls/transactional';
import { inTransaction } from '../src/core/database/transactions.js';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq, inArray } from 'drizzle-orm';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';
import type { Database } from '../src/core/database/drizzle.js';
import { TenantScopeMissingError } from '../src/core/tenancy/tenant-scope.js';
import { notes } from '../src/features/notes/notes.tables.js';
import { SoftDeletePurgeJob } from '../src/iam/resources/soft-delete-purge.job.js';
import { Realtime } from '../src/platform/realtime/realtime.service.js';
import { bootApp, newPassword, type TestApp } from './support.js';

/**
 * The tenant wall (docs/tenancy.md): row-level security proven as the app
 * role itself, then every per-principal key and flow that could carry one
 * tenant's data into another (sessions and the switch, API clients,
 * idempotency replays, realtime rooms, impersonation), and a cron job doing
 * real work under the policies.
 */
describe('tenancy (e2e)', () => {
  let node: TestApp;
  let other: Awaited<ReturnType<TestApp['otherTenant']>>;

  beforeEach(async () => {
    node = await bootApp();
    other = await node.otherTenant();
  });
  afterEach(() => node.close());

  const db = () => node.app.get<Database>(getDrizzleToken());

  /** A note written by a new API client of the seeded tenant, and one of the other tenant. */
  async function noteInEach() {
    const mine = await node.client();
    const theirs = await other.client();
    const a = await node.writeNote(mine.auth, { title: 'A', body: 'a' });
    const b = await node.writeNote(theirs.auth, { title: 'B', body: 'b' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    return {
      mine,
      theirs,
      a: a.body.id as string,
      b: b.body.id as string,
    };
  }

  /** An account that belongs to both tenants: invited by each, accepted each time (the second signed in). */
  async function memberOfBoth() {
    const mine = await node.user(['editor']);
    const editor = (await other.admin.get('/v1/access/roles').expect(200)).body
      .items as { id: string; key: string | null }[];
    const token = await node.invite(other.admin, {
      email: mine.email,
      roleIds: [editor.find((role) => role.key === 'editor')!.id],
    });
    await mine.agent
      .post('/v1/auth/invitations/accept')
      .send({ token })
      .expect(200);
    return { id: mine.id, email: mine.email, password: mine.password };
  }

  describe('as the app role, in SQL', () => {
    it('shows no row of another tenant, and refuses to write one', async () => {
      const { a, b } = await noteInEach();
      const app = new Client({ connectionString: node.database.url });
      await app.connect();
      try {
        // No setting at all (a fresh connection): nothing.
        const none = await app.query('select id from notes');
        expect(none.rows).toEqual([]);

        await app.query('begin');
        await app.query(
          `select set_config('app.tenant_id', $1, true), set_config('app.read_tenants', $1, true)`,
          [node.tenantId],
        );
        const read = await app.query<{ id: string }>('select id from notes');
        expect(read.rows.map((row) => row.id)).toEqual([a]);
        // Another tenant's row: not there to read, update or delete…
        const byId = await app.query('select id from notes where id = $1', [b]);
        expect(byId.rows).toEqual([]);
        const updated = await app.query(
          `update notes set title = 'stolen' where id = $1`,
          [b],
        );
        expect(updated.rowCount).toBe(0);
        const deleted = await app.query('delete from notes where id = $1', [b]);
        expect(deleted.rowCount).toBe(0);
        // …and not one to write into: the insert fails (WITH CHECK).
        await app.query('savepoint insert_elsewhere');
        await expect(
          app.query(
            `insert into notes (tenant_id, owner_id, title, body, status) values ($1, 'client:x', 'smuggled', '', 'draft')`,
            [other.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        await app.query('rollback to savepoint insert_elsewhere');
        // Nor may a row move to it.
        await expect(
          app.query(`update notes set tenant_id = $1 where id = $2`, [
            other.id,
            a,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
        await app.query('rollback');
      } finally {
        await app.end();
      }
      // The other tenant's note is untouched.
      const still = await node.inTenant(
        () => db().select().from(notes).where(eq(notes.id, b)),
        other.id,
      );
      expect(still[0]?.title).toBe('B');
    });

    it('binds the owner too (FORCE): without a tenant it reads nothing', async () => {
      await noteInEach();
      const owner = new Client({ connectionString: node.database.ownerUrl });
      await owner.connect();
      try {
        const rows = await owner.query('select id from notes');
        expect(rows.rows).toEqual([]);
      } finally {
        await owner.end();
      }
    });

    it('puts every table with a tenant_id behind its wall, but the two global ones', async () => {
      const app = new Client({ connectionString: node.database.url });
      await app.connect();
      try {
        const role = await app.query(
          `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
        );
        expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        const { rows } = await app.query<{
          name: string;
          enabled: boolean;
          forced: boolean;
          policies: number;
          owned: boolean;
        }>(
          `select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                  (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
                  pg_get_userbyid(c.relowner) = current_user as owned
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
           where n.nspname = 'public' and c.relkind = 'r'
           order by 1`,
        );
        const walled = rows.filter(
          (row) => !['memberships', 'api_keys'].includes(row.name),
        );
        expect(walled.length).toBeGreaterThan(20);
        for (const row of walled) {
          expect(row).toEqual({
            name: row.name,
            enabled: true,
            forced: true,
            policies: 4,
            owned: false,
          });
        }
      } finally {
        await app.end();
      }
    });
  });

  it('refuses a query on a tenant table without a tenant, before sending it', async () => {
    // Drizzle wraps the pool's refusal: the cause says it.
    const refused = await db()
      .select()
      .from(notes)
      .catch((error: { cause?: unknown }) => error.cause);
    expect(refused).toBeInstanceOf(TenantScopeMissingError);
    expect((refused as Error).message).toMatch(/notes ran without a tenant/);
    // In a tenant's scope, the same query reads that tenant's rows only.
    const { a } = await noteInEach();
    const rows = await node.inTenant(() =>
      db().select({ id: notes.id }).from(notes),
    );
    expect(rows.map((row) => row.id)).toEqual([a]);
  });

  it('refuses to move work to another tenant inside an open transaction', async () => {
    const tenancy = node.app.get(Tenancy);
    const txHost = node.app.get(TransactionHost);
    await expect(
      node.inTenant(() =>
        inTransaction(txHost as never, () =>
          tenancy.run(other.id, async () => 'moved'),
        ),
      ),
    ).rejects.toThrow(/must start its own, outside it/);
    // The same tenant's work joins it.
    expect(
      await node.inTenant(() =>
        inTransaction(txHost as never, () =>
          tenancy.run(node.tenantId, async () => 'joined'),
        ),
      ),
    ).toBe('joined');
  });

  it('keeps an API client in its own tenant', async () => {
    const { mine, theirs, a, b } = await noteInEach();
    const listed = await node
      .http()
      .get('/v1/notes')
      .set('Authorization', theirs.auth)
      .expect(200);
    expect(listed.body.items.map((note: { id: string }) => note.id)).toEqual([
      b,
    ]);
    await node
      .http()
      .get(`/v1/notes/${a}`)
      .set('Authorization', theirs.auth)
      .expect(404);
    await node
      .http()
      .delete(`/v1/notes/${a}`)
      .set('Authorization', theirs.auth)
      .expect(404);
    // The administrators see their own tenant's clients only.
    const clients = (await other.admin.get('/v1/access/clients').expect(200))
      .body.items as { id: string }[];
    expect(clients.map((client) => client.id)).toEqual([theirs.id]);
    await other.admin
      .patch(`/v1/access/clients/${mine.id}`)
      .send({ active: false })
      .expect(404);
    // The notes of A are still A's alone.
    const own = await node
      .http()
      .get('/v1/notes')
      .set('Authorization', mine.auth)
      .expect(200);
    expect(own.body.items.map((note: { id: string }) => note.id)).toEqual([a]);
  });

  it('lists only its own members, and adds anyone only by an invitation its owner accepts', async () => {
    const ours = await node.user(['viewer']);
    const members = (await other.admin.get('/v1/access/users').expect(200)).body
      .items as { id: string }[];
    expect(members.map((user) => user.id)).not.toContain(ours.id);
    await other.admin
      .patch(`/v1/access/users/${ours.id}`)
      .send({ active: false })
      .expect(404);

    // Inviting an existing account and a new address: the same answer,
    // nothing about the account, and no password ever.
    const fresh = `${randomUUID().slice(0, 8)}@example.com`;
    const toExisting = await other.admin
      .post('/v1/access/users')
      .send({ email: ours.email, roleIds: [] })
      .expect(202);
    const toNew = await other.admin
      .post('/v1/access/users')
      .send({ email: fresh, roleIds: [] })
      .expect(202);
    expect(Object.keys(toExisting.body).sort()).toEqual(
      Object.keys(toNew.body).sort(),
    );
    expect(toExisting.body).not.toHaveProperty('name');
    await other.admin
      .post('/v1/access/users')
      .send({ email: fresh, password: newPassword(), roleIds: [] })
      .expect(400);
    await other.admin
      .patch(`/v1/access/users/${ours.id}`)
      .send({ password: newPassword() })
      .expect(400);

    // Until accepted, the account is untouched and not a member.
    const token = await node.invite(other.admin, { email: ours.email });
    await node.signIn(ours.email, ours.password);
    const before = (await other.admin.get('/v1/access/users').expect(200)).body
      .items as { id: string }[];
    expect(before.map((user) => user.id)).not.toContain(ours.id);
    // Accepting takes the account's owner, signed in as it.
    await node
      .http()
      .post('/v1/auth/invitations/accept')
      .send({ token })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe('sign_in_required'));
    const someoneElse = await node.user([]);
    await someoneElse.agent
      .post('/v1/auth/invitations/accept')
      .send({ token })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('invitation_other_account'));
    await ours.agent
      .post('/v1/auth/invitations/accept')
      .send({ token })
      .expect(200);
    await ours.agent
      .post('/v1/auth/invitations/accept')
      .send({ token })
      .expect(400);
    const after = (await other.admin.get('/v1/access/users').expect(200)).body
      .items as { id: string }[];
    expect(after.map((user) => user.id)).toContain(ours.id);
  });

  it('switches the session between the user’s tenants, and nowhere else', async () => {
    const both = await memberOfBoth();
    const browser = await node.signIn(both.email, both.password);
    const me = await browser.get('/v1/auth/me').expect(200);
    expect(me.body.tenant.id).toBe(node.tenantId);
    const tenants = (await browser.get('/v1/auth/tenants').expect(200)).body
      .items as { id: string; current: boolean }[];
    expect(tenants.map((tenant) => tenant.id).sort()).toEqual(
      [node.tenantId, other.id].sort(),
    );

    // A tenant they don't belong to: 404, the session unchanged.
    const outsider = await node.otherTenant();
    await browser
      .post('/v1/auth/tenant')
      .send({ tenantId: outsider.id })
      .expect(404);

    const mine = await node
      .writeNote(browser, { title: 'In A', body: '' })
      .expect(201);
    const before = browser.jar.getCookies({
      domain: '127.0.0.1',
      path: '/',
      secure: false,
      script: false,
    });
    const switched = await browser
      .post('/v1/auth/tenant')
      .send({ tenantId: other.id })
      .expect(204);
    expect(switched.headers['set-cookie']).toBeDefined();
    expect((await browser.get('/v1/auth/me').expect(200)).body.tenant.id).toBe(
      other.id,
    );
    // In B, A's note is nowhere, and B's own list is B's.
    await browser.get(`/v1/notes/${mine.body.id}`).expect(404);
    const listed = await browser.get('/v1/notes').expect(200);
    expect(listed.body.items).toEqual([]);
    // The old cookie is gone with the old session.
    const stale = before.map((cookie) => `${cookie.name}=${cookie.value}`);
    await node
      .http()
      .get('/v1/auth/me')
      .set('Cookie', stale.join('; '))
      .expect(401);
    // Its name is its own: no tenant's administrator changes it.
    await other.admin
      .patch(`/v1/access/users/${both.id}`)
      .send({ name: 'Renamed' })
      .expect(400);
  });

  it('never replays one tenant’s idempotent response in another', async () => {
    const both = await memberOfBoth();
    const browser = await node.signIn(both.email, both.password);
    const key = randomUUID();
    const first = await node
      .writeNote(browser, { title: 'Same', body: '' }, key)
      .expect(201);
    await browser
      .post('/v1/auth/tenant')
      .send({ tenantId: other.id })
      .expect(204);
    const second = await node
      .writeNote(browser, { title: 'Same', body: '' }, key)
      .expect(201);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body.id).not.toBe(first.body.id);
    // And back in A, the first one replays.
    await browser
      .post('/v1/auth/tenant')
      .send({ tenantId: node.tenantId })
      .expect(204);
    const replayed = await node
      .writeNote(browser, { title: 'Same', body: '' }, key)
      .expect(201);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expect(replayed.body.id).toBe(first.body.id);
  });

  it('keeps an impersonation in the tenant it began in', async () => {
    const both = await memberOfBoth();
    const ours = await node.user(['viewer']);
    // Not a member of B: B's administrator can't act as them.
    await other.admin
      .post(`/v1/access/users/${ours.id}/impersonate`)
      .expect(404);
    // A member of both, impersonated in B, acts in B only.
    await other.admin
      .post(`/v1/access/users/${both.id}/impersonate`)
      .expect(204);
    const me = await other.admin.get('/v1/auth/me').expect(200);
    expect(me.body.user.id).toBe(both.id);
    expect(me.body.tenant.id).toBe(other.id);
    await other.admin
      .post('/v1/auth/tenant')
      .send({ tenantId: node.tenantId })
      .expect(403);
    await other.admin
      .patch('/v1/auth/me')
      .send({ name: 'Hijacked' })
      .expect(403);
    await other.admin.post('/v1/auth/impersonation/stop').expect(204);
    const back = await other.admin.get('/v1/auth/me').expect(200);
    expect(back.body.user.email).toBe(other.email);
    expect(back.body.tenant.id).toBe(other.id);
  });

  it('delivers realtime events to the tenant’s room only', async () => {
    const both = await memberOfBoth();
    const tokenIn = async (tenantId: string) =>
      (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: both.email, password: both.password, tenantId })
          .expect(200)
      ).body.accessToken as string;
    const { port } = node.app.getHttpServer().address() as AddressInfo;
    const socket: Socket = io(`http://127.0.0.1:${port}/realtime`, {
      auth: { token: await tokenIn(node.tenantId) },
      transports: ['websocket'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const heard: string[] = [];
      socket.on('tenancy.test', (data: { tenant: string }) =>
        heard.push(data.tenant),
      );
      const realtime = node.app.get(Realtime);
      const principal = { kind: 'user' as const, id: both.id };
      await node.inTenant(async () => {
        realtime.toPrincipal(principal, 'tenancy.test', { tenant: 'B' });
      }, other.id);
      await node.inTenant(async () => {
        realtime.toPrincipal(principal, 'tenancy.test', { tenant: 'A' });
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(heard).toEqual(['A']);
    } finally {
      socket.disconnect();
    }
    // A token for a tenant the user isn't in: refused like a wrong password.
    const outsider = await node.otherTenant();
    await node
      .http()
      .post('/v1/auth/token')
      .send({
        email: both.email,
        password: both.password,
        tenantId: outsider.id,
      })
      .expect(401);
  });

  it('disconnects a member’s sockets in a tenant when that membership is deactivated', async () => {
    const both = await memberOfBoth();
    const token = (
      await node
        .http()
        .post('/v1/auth/token')
        .send({
          email: both.email,
          password: both.password,
          tenantId: node.tenantId,
        })
        .expect(200)
    ).body.accessToken as string;
    const { port } = node.app.getHttpServer().address() as AddressInfo;
    const socket: Socket = io(`http://127.0.0.1:${port}/realtime`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const gone = new Promise<string>((resolve) =>
        socket.once('disconnect', resolve),
      );
      await node
        .admin()
        .patch(`/v1/access/users/${both.id}`)
        .send({ active: false })
        .expect(204);
      expect(await gone).toBe('io server disconnect');
    } finally {
      socket.disconnect();
    }
  });

  it('runs a cron job under row-level security, doing real work in every tenant', async () => {
    const { mine, theirs } = await noteInEach();
    const deleted: string[] = [];
    for (const auth of [mine.auth, theirs.auth]) {
      const note = await node
        .writeNote(auth, { title: 'Old', body: '' })
        .expect(201);
      await node
        .http()
        .delete(`/v1/notes/${note.body.id}`)
        .set('Authorization', auth)
        .expect(204);
      deleted.push(note.body.id);
    }
    await node.acrossTenants(() =>
      db()
        .update(notes)
        .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
        .where(inArray(notes.id, deleted)),
    );
    await node.app.get(SoftDeletePurgeJob).run();
    const left = await node.acrossTenants(() =>
      db().select({ id: notes.id, tenantId: notes.tenantId }).from(notes),
    );
    expect(left).toHaveLength(2);
    expect(left.map((row) => row.id)).not.toEqual(
      expect.arrayContaining([deleted[0]]),
    );
    expect(left.map((row) => row.id)).not.toEqual(
      expect.arrayContaining([deleted[1]]),
    );
    expect(new Set(left.map((row) => row.tenantId))).toEqual(
      new Set([node.tenantId, other.id]),
    );
  });

  it('lets only the operators make tenants', async () => {
    await other.admin
      .post('/v1/tenants')
      .send({
        name: 'Nope',
        slug: `nope-${randomUUID().slice(0, 6)}`,
        administratorEmail: 'nope@example.com',
      })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('operator_required'));
    await other.admin.get('/v1/ops/queues').expect(403);
    const listed = (await node.admin().get('/v1/tenants').expect(200)).body
      .items as { id: string; operator: boolean }[];
    expect(listed.find((tenant) => tenant.operator)?.id).toBe(node.tenantId);
  });
});
