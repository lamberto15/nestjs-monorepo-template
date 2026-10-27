import { bootApp, type TestApp } from './support.js';

describe('access control (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  it('seeds Administrator and the roles the declarations ask for', async () => {
    const roles = await node.admin().get('/v1/access/roles').expect(200);
    expect(roles.body.items.map((role: { name: string }) => role.name)).toEqual(
      ['Administrator', 'Editor', 'Team lead', 'Viewer'],
    );
  });

  it('shows the catalog every group and feature declared', async () => {
    const catalog = await node.admin().get('/v1/access/catalog').expect(200);
    const subjects = catalog.body.subjects.map(
      (s: { subject: string }) => s.subject,
    );
    // The groups' subjects, then the features' (and the test-only record's).
    expect(subjects.slice(0, 5)).toEqual([
      'Access',
      'Platform',
      'Approval',
      'Ops',
      'MailSuppression',
    ]);
    expect(subjects).toContain('TestItem');
  });

  it('opens each access and ops route only to the permissions it needs: 403 otherwise', async () => {
    const viewer = (await node.user(['viewer'])).agent;
    await viewer.get('/v1/ops/outbox').expect(200);
    await viewer.post('/v1/ops/dead-letters/purge').send({}).expect(403);
    await viewer.get('/v1/access/roles').expect(403);

    const editor = (await node.user(['editor'])).agent;
    await editor.get('/v1/ops/outbox').expect(403);
    const me = await editor.get('/v1/auth/me').expect(200);
    expect(me.body.can).toMatchObject({
      'TestItem.create': true,
      'TestItem.read': true, // their own items: allowed on some records
      'Ops.view': false,
      'Access.manageRoles': false,
    });
  });

  it('applies a role change from the next request', async () => {
    const { id, agent } = await node.user(['editor']);
    await agent.get('/v1/ops/outbox').expect(403);
    await node
      .admin()
      .patch(`/v1/access/users/${id}`)
      .send({ roleIds: await node.roleIds('editor', 'viewer') })
      .expect(204);
    await agent.get('/v1/ops/outbox').expect(200);
  });

  it('refuses a role save or delete from a stale read: 412 with If-Match (#749)', async () => {
    const admin = node.admin();
    const role = {
      name: 'Auditor',
      permissions: [{ subject: 'Ops', action: 'view', conditions: [] }],
    };
    const created = await admin.post('/v1/access/roles').send(role).expect(201);
    const url = `/v1/access/roles/${created.body.id}`;
    const etag = (await admin.get(url).expect(200)).headers.etag as string;
    expect(etag).toMatch(/^"/);
    // A grant changes `members`, not the role: the tag stays.
    await node.user([created.body.id]);
    expect((await admin.get(url).expect(200)).headers.etag).toBe(etag);

    // Two administrators read the same version: the first save wins, and
    // answers with the role's new tag.
    const saved = await admin
      .patch(url)
      .set('If-Match', etag)
      .send({ ...role, description: 'first' })
      .expect(204);
    const stale = await admin
      .patch(url)
      .set('If-Match', etag)
      .send({ ...role, description: 'second' })
      .expect(412);
    const current = (await admin.get(url).expect(200)).headers.etag as string;
    expect(saved.headers.etag).toBe(current);
    expect(stale.body).toMatchObject({
      code: 'precondition_failed',
      etag: current,
    });
    expect((await admin.get(url)).body.description).toBe('first');
    await admin.delete(url).set('If-Match', etag).expect(412);
    await admin.delete(url).set('If-Match', current).expect(204);
  });

  describe('safeguards', () => {
    /** A user who may manage roles and users, and nothing else. */
    async function accessManager() {
      const role = await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: 'Access manager',
          permissions: [
            { subject: 'Access', action: 'manageRoles', conditions: [] },
            { subject: 'Access', action: 'manageUsers', conditions: [] },
          ],
        })
        .expect(201);
      return node.user([role.body.id]);
    }

    it("refuses to grant what the granter doesn't hold without conditions", async () => {
      const { agent } = await accessManager();
      const refused = await agent
        .post('/v1/access/roles')
        .send({
          name: 'Ops',
          permissions: [{ subject: 'Ops', action: 'manage', conditions: [] }],
        })
        .expect(403);
      expect(refused.body.detail).toContain('You can’t grant Ops.manage');
      // Nor give someone a role that holds it.
      await agent
        .post('/v1/access/users')
        .send({
          email: 'new@example.com',
          name: 'New',
          roleIds: await node.roleIds('viewer'),
        })
        .expect(403);
    });

    it('refuses permissions and conditions the catalog does not declare: 400', async () => {
      await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: 'Bad',
          permissions: [
            {
              subject: 'TestItem',
              action: 'read',
              conditions: [{ key: 'undeclared' }],
            },
          ],
        })
        .expect(400);
      await node
        .admin()
        .post('/v1/access/roles')
        .send({
          name: 'Bad',
          permissions: [{ subject: 'Nope', action: 'read', conditions: [] }],
        })
        .expect(400);
    });

    it('keeps the built-in Administrator role, and at least one active administrator', async () => {
      const [administrator] = await node.roleIds('administrator');
      await node
        .admin()
        .delete(`/v1/access/roles/${administrator}`)
        .expect(409);
      await node.admin().delete('/v1/access/roles/administrator').expect(400);
      const me = await node.admin().get('/v1/auth/me').expect(200);
      await node
        .admin()
        .patch(`/v1/access/users/${me.body.user.id}`)
        .send({ roleIds: [] })
        .expect(409);
      await node
        .admin()
        .patch(`/v1/access/users/${me.body.user.id}`)
        .send({ active: false })
        .expect(409);
    });

    it('audits every access change in its transaction', async () => {
      await accessManager();
      const client = await node.client('Audited');
      await node
        .admin()
        .post(`/v1/access/clients/${client.id}/rotate`)
        .expect(200);
      const audit = await node.admin().get('/v1/access/audit').expect(200);
      const actions = audit.body.items.map(
        (entry: { action: string }) => entry.action,
      );
      expect(actions).toEqual(
        expect.arrayContaining([
          'role.created',
          'user.invited',
          'user.joined',
          'client.created',
          'client.key-rotated',
          'user.seeded',
        ]),
      );
    });

    it('filters the audit log and the users', async () => {
      const { id } = await node.user(['viewer']);
      const created = await node
        .admin()
        .get('/v1/access/audit?action=user.joined&targetId=' + id)
        .expect(200);
      expect(created.body.items).toHaveLength(1);
      const byPrefix = await node
        .admin()
        .get('/v1/access/audit?action.startsWith=auth.')
        .expect(200);
      expect(
        byPrefix.body.items.every((e: { action: string }) =>
          e.action.startsWith('auth.'),
        ),
      ).toBe(true);
      const admins = await node
        .admin()
        .get('/v1/access/users?email.contains=admin@')
        .expect(200);
      expect(admins.body.items.map((u: { email: string }) => u.email)).toEqual([
        'admin@example.com',
      ]);
      await node.admin().get('/v1/access/users?active=maybe').expect(400);
    });
  });

  describe('organization hierarchy', () => {
    it('lets a lead see the items of their teams and every team below them', async () => {
      const admin = node.admin();
      const team = async (name: string, parentId?: string) =>
        (
          await admin
            .post('/v1/access/teams')
            .send({ name, parentId })
            .expect(201)
        ).body.id as string;
      const sales = await team('Sales');
      const north = await team('North', sales);
      const south = await team('South', sales);
      const northEast = await team('North East', north);

      const teams = (await admin.get('/v1/access/teams').expect(200)).body
        .items;
      expect(
        teams.find((u: { id: string }) => u.id === northEast),
      ).toMatchObject({ depth: 2, parentId: north });

      // Members write items in their teams.
      const [lead] = await node.roleIds('team-lead');
      const member = async (teamId: string) => {
        const created = await node.user(['editor']);
        await admin
          .patch(`/v1/access/users/${created.id}`)
          .send({ teamIds: [teamId] })
          .expect(204);
        return created.agent;
      };
      await node
        .writeItem(await member(northEast), {
          title: 'From North East',
          body: 'x',
        })
        .expect(201);
      await node
        .writeItem(await member(south), { title: 'From South', body: 'x' })
        .expect(201);

      const leadOf = async (teamId: string) => {
        const created = await node.user([lead]);
        await admin
          .patch(`/v1/access/users/${created.id}`)
          .send({ teamIds: [teamId] })
          .expect(204);
        const items = (await created.agent.get('/v1/test-items').expect(200))
          .body.items as { title: string }[];
        return items
          .map((item) => item.title)
          .sort((a, b) => a.localeCompare(b));
      };
      expect(await leadOf(sales)).toEqual(['From North East', 'From South']);
      expect(await leadOf(north)).toEqual(['From North East']);
      expect(await leadOf(south)).toEqual(['From South']);

      // Moving a subtree moves what is seen through it.
      await admin
        .patch(`/v1/access/teams/${north}`)
        .send({ parentId: south })
        .expect(200);
      expect(await leadOf(south)).toEqual(['From North East', 'From South']);
      // Never under itself or its own teams.
      await admin
        .patch(`/v1/access/teams/${south}`)
        .send({ parentId: northEast })
        .expect(400);
      // Only empty teams can go.
      await admin.delete(`/v1/access/teams/${south}`).expect(409);
    });
  });
});
