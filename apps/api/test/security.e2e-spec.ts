import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { AccountService } from '../src/iam/account/account.service.js';
import type { UserPrincipal } from '../src/iam/auth/principal.js';
import { userIdentities, users } from '../src/iam/iam.tables.js';
import { bootApp, newPassword, type TestApp } from './support.js';

/**
 * The rules that keep one account from gaining rights through another:
 * regressions for the security review's findings.
 */
describe('security (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  /** A role made of these permissions (no conditions). */
  async function role(...permissions: [string, string][]) {
    const created = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `role-${randomUUID().slice(0, 8)}`,
        permissions: permissions.map(([subject, action]) => ({
          subject,
          action,
          conditions: [],
        })),
      })
      .expect(201);
    return created.body.id as string;
  }

  const adminId = async () =>
    (await node.admin().get('/v1/auth/me').expect(200)).body.user.id as string;

  it('lets nobody act on an account that holds more than they do', async () => {
    const support = await node.user([await role(['Access', 'manageUsers'])]);
    const admin = await adminId();
    // Not the administrator's password, nor their activation…
    const refused = await support.agent
      .patch(`/v1/access/users/${admin}`)
      .send({ password: newPassword() })
      .expect(403);
    expect(refused.body.code).toBe('authority_required');
    await support.agent
      .patch(`/v1/access/users/${admin}`)
      .send({ active: false })
      .expect(403);
    // …but an account with fewer rights, yes.
    const viewer = await node.user(['viewer']);
    const viewerRole = await role(['Note', 'read']);
    const supportHoldsNotes = await node.user([
      await role(['Access', 'manageUsers'], ['Note', 'read'], ['Ops', 'view']),
    ]);
    await supportHoldsNotes.agent
      .patch(`/v1/access/users/${viewer.id}`)
      .send({ roleIds: [viewerRole] })
      .expect(204);
    // Own org units: never.
    const unit = await node
      .admin()
      .post('/v1/access/org-units')
      .send({ name: 'Sales' })
      .expect(201);
    await support.agent
      .patch(`/v1/access/users/${support.id}`)
      .send({ orgUnitIds: [unit.body.id] })
      .expect(403);
    // Org units are their own permission.
    await support.agent
      .post('/v1/access/org-units')
      .send({ name: 'Mine' })
      .expect(403);
  });

  it('keeps a grant’s end when the roles are sent again', async () => {
    const [viewer] = await node.roleIds('viewer');
    const { id } = await node.user([]);
    const end = new Date(Date.now() + 3_600_000).toISOString();
    await node
      .admin()
      .patch(`/v1/access/users/${id}`)
      .send({ roleIds: [viewer], roleExpiresAt: { [viewer]: end } })
      .expect(204);
    await node
      .admin()
      .patch(`/v1/access/users/${id}`)
      .send({ roleIds: [viewer] })
      .expect(204);
    const users = await node
      .admin()
      .get('/v1/access/users?limit=100')
      .expect(200);
    const user = users.body.items.find((u: { id: string }) => u.id === id);
    expect(new Date(user.roles[0].expiresAt).toISOString()).toBe(end);
  });

  it('never lets impersonation reach more rights, nor manage access meanwhile', async () => {
    const supportRole = await role(['Access', 'impersonate'], ['Note', 'read']);
    const support = await node.user([supportRole]);
    const manager = await node.user([await role(['Access', 'manageUsers'])]);
    const weaker = await node.user([await role(['Note', 'read'])]);

    const refused = await support.agent
      .post(`/v1/access/users/${manager.id}/impersonate`)
      .expect(403);
    expect(refused.body.code).toBe('authority_required');

    // An administrator impersonating a manager can't use the manager's access rights.
    const admin = await node.signIn(
      process.env.ADMIN_EMAIL!,
      process.env.ADMIN_PASSWORD!,
    );
    await admin.post(`/v1/access/users/${manager.id}/impersonate`).expect(204);
    await admin
      .patch(`/v1/access/users/${weaker.id}`)
      .send({ name: 'Changed' })
      .expect(403);
    // Nor link an identity to the account (refused before the route looks for the provider).
    await admin.get('/v1/auth/oidc/google/login?link=true').expect(403);
    await admin.post('/v1/auth/impersonation/stop').expect(204);

    await support.agent
      .post(`/v1/access/users/${weaker.id}/impersonate`)
      .expect(204);
  });

  it('rotates only the keys of clients the actor has authority over', async () => {
    const clientManager = await node.user([
      await role(['Access', 'manageClients']),
    ]);
    const client = await node.client();
    await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ roleIds: await node.roleIds('viewer') })
      .expect(200);
    const refused = await clientManager.agent
      .post(`/v1/access/clients/${client.id}/rotate`)
      .expect(403);
    expect(refused.body.code).toBe('authority_required');
    const plain = await node.client();
    await clientManager.agent
      .post(`/v1/access/clients/${plain.id}/rotate`)
      .expect(200);
  });

  it('refuses keys that would already have expired', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await node
      .admin()
      .post('/v1/access/clients')
      .send({ name: `past-${Date.now()}`, keyExpiresAt: past })
      .expect(400);
    const client = await node.client();
    await node
      .admin()
      .post(`/v1/access/clients/${client.id}/rotate`)
      .send({ expiresAt: past })
      .expect(400);
  });

  it('checks field-level permissions on create', async () => {
    const titlesOnly = await role(['Note', 'read']);
    const creator = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `create-titles-${randomUUID().slice(0, 8)}`,
        permissions: [
          { subject: 'Note', action: 'create', conditions: [], fields: [] },
        ],
      })
      .expect(201);
    const user = await node.user([titlesOnly, creator.body.id]);
    const refused = await node
      .writeNote(user.agent, { title: 'T', body: 'secret text' })
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'field_forbidden',
      fields: ['body'],
    });
    await node.writeNote(user.agent, { title: 'T', body: '' }).expect(201);
  });

  it('never unlinks the last way to sign in, even with two unlinks at once', async () => {
    const { id } = await node.user([]);
    const db = node.app.get<Database>(getDrizzleToken());
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, id));
    await db.insert(userIdentities).values([
      { provider: 'google', subject: `g-${id}`, userId: id },
      { provider: 'github', subject: `h-${id}`, userId: id },
    ]);
    const account = node.app.get(AccountService);
    const user = {
      kind: 'user',
      id,
      email: `${id}@example.com`,
      name: 'Linked only',
    } as UserPrincipal;
    const results = await Promise.allSettled([
      account.unlinkIdentity(user, 'google'),
      account.unlinkIdentity(user, 'github'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason.getStatus()).toBe(409);
    const left = await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, id));
    expect(left).toHaveLength(1);
  });
});
