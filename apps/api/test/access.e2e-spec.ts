import { randomUUID } from 'node:crypto';
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
      ['Administrator', 'Editor', 'Unit lead', 'Viewer'],
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
    await viewer
      .post('/v1/ops/backlog/discard')
      .send({ target: 'mail', scope: { global: true } })
      .expect(403);
    await viewer.post('/v1/ops/queues/mail/pause').expect(403);
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

  describe('explaining access (#562)', () => {
    type Explained = {
      roles: { id: string; expired: boolean }[];
      actions: {
        action: string;
        allowed: boolean | null;
        fields: string[] | null;
        grants: { roleId: string; matches: boolean | null }[];
      }[];
    };
    const action = (body: Explained, name: string) =>
      body.actions.find((explained) => explained.action === name)!;

    it('explains each action as the engine decides it: overlapping grants, fields, an ended grant', async () => {
      const admin = node.admin();
      const owner = await node.user(['editor']);
      const theirs = (
        await node
          .writeItem(owner.agent, { title: 'Theirs', body: 'x' })
          .expect(201)
      ).body.id as string;
      // Every item without its text, beside the editor's own items with it.
      const textless = (
        await admin
          .post('/v1/access/roles')
          .send({
            name: `textless-${randomUUID().slice(0, 8)}`,
            permissions: [
              {
                subject: 'TestItem',
                action: 'read',
                conditions: [],
                fields: [],
              },
            ],
          })
          .expect(201)
      ).body.id as string;
      const [editor, viewer] = await node.roleIds('editor', 'viewer');
      const user = await node.user([]);
      await admin
        .patch(`/v1/access/users/${user.id}`)
        .send({
          roleIds: [editor, textless, viewer],
          roleExpiresAt: {
            [viewer!]: new Date(Date.now() + 1500).toISOString(),
          },
        })
        .expect(204);
      await new Promise((resolve) => setTimeout(resolve, 1700));
      const own = (
        await node
          .writeItem(user.agent, { title: 'Own', body: 'y' })
          .expect(201)
      ).body.id as string;
      const explain = (query: Record<string, string>) =>
        admin.get(`/v1/access/users/${user.id}/explanation`).query(query);

      const onTheirs = (
        await explain({ subject: 'TestItem', recordId: theirs }).expect(200)
      ).body as Explained;
      expect(action(onTheirs, 'read')).toMatchObject({
        allowed: true,
        fields: [],
      });
      expect(
        action(onTheirs, 'read').grants.map((g) => [g.roleId, g.matches]),
      ).toEqual(
        expect.arrayContaining([
          [editor, false],
          [textless, true],
        ]),
      );
      // The ended grant counts for nothing, and says so.
      expect(
        action(onTheirs, 'read').grants.some((g) => g.roleId === viewer),
      ).toBe(false);
      expect(onTheirs.roles.find((role) => role.id === viewer)).toMatchObject({
        expired: true,
      });
      expect(action(onTheirs, 'update').allowed).toBe(false);
      // What their requests get: the item without its text, no change.
      const seen = await user.agent.get(`/v1/test-items/${theirs}`).expect(200);
      expect(seen.body).not.toHaveProperty('body');
      await user.agent
        .patch(`/v1/test-items/${theirs}`)
        .send({ title: 'No' })
        .expect(403);

      const onOwn = (
        await explain({ subject: 'TestItem', recordId: own }).expect(200)
      ).body as Explained;
      // Every restrictable field: the custom fields and the text.
      expect(action(onOwn, 'read')).toMatchObject({
        allowed: true,
        fields: ['custom', 'body'],
      });
      expect(action(onOwn, 'update').allowed).toBe(true);

      // Without a record: on some records at least.
      const anywhere = (await explain({ subject: 'TestItem' }).expect(200))
        .body as Explained;
      expect(action(anywhere, 'update').allowed).toBe(true);

      expect(
        (await explain({ subject: 'Nothing' }).expect(400)).body.code,
      ).toBe('unknown_subject');
      await explain({ subject: 'TestItem', recordId: randomUUID() }).expect(
        404,
      );
      // Only who hands out roles or manages users asks.
      const viewing = await node.user(['viewer']);
      await viewing.agent
        .get(`/v1/access/users/${user.id}/explanation`)
        .query({ subject: 'TestItem' })
        .expect(403);
    });

    it("keeps to the tenant: another tenant's administrator finds neither the member nor the record", async () => {
      const owner = await node.user(['editor']);
      const item = (await node.writeItem(owner.agent).expect(201)).body
        .id as string;
      const other = await node.otherTenant();
      await other.admin
        .get(`/v1/access/users/${owner.id}/explanation`)
        .query({ subject: 'TestItem' })
        .expect(404);
      const theirs = await other.user(['editor']);
      await other.admin
        .get(`/v1/access/users/${theirs.id}/explanation`)
        .query({ subject: 'TestItem', recordId: item })
        .expect(404);
    });
  });

  describe('organizational units', () => {
    /** Units Sales > North > North East and Sales > South, with a test item written in each but North. */
    async function tree() {
      const admin = node.admin();
      const unit = async (type: string, name: string, parentId?: string) =>
        (
          await admin
            .post('/v1/access/organizational-units')
            .send({ type, name, parentId })
            .expect(201)
        ).body.id as string;
      const sales = await unit('division', 'Sales');
      const north = await unit('department', 'North', sales);
      const south = await unit('team', 'South', sales);
      const northEast = await unit('team', 'North East', north);
      // A member of exactly one unit writes items of that unit.
      const writer = async (unitId: string, title: string) => {
        const created = await node.user(['editor']);
        await admin
          .post(`/v1/access/organizational-units/${unitId}/members`)
          .send({ userId: created.id })
          .expect(201);
        const item = await node
          .writeItem(created.agent, { title, body: 'x' })
          .expect(201);
        expect(item.body.unitId).toBe(unitId);
        return created.id;
      };
      await writer(northEast, 'From North East');
      await writer(south, 'From South');
      await writer(sales, 'From Sales');
      return { admin, sales, north, south, northEast };
    }

    /** What a user with these roles sees of the test items, by title. */
    const titles = async (
      agent: Awaited<ReturnType<TestApp['user']>>['agent'],
    ) =>
      (
        (await agent.get('/v1/test-items').expect(200)).body.items as {
          title: string;
        }[]
      )
        .map((item) => item.title)
        .sort((a, b) => a.localeCompare(b));

    /** A role reading test items under one unit condition. */
    const readingWith = async (key: string) =>
      (
        await node
          .admin()
          .post('/v1/access/roles')
          .send({
            name: `role-${randomUUID().slice(0, 8)}`,
            permissions: [
              { subject: 'TestItem', action: 'read', conditions: [{ key }] },
            ],
          })
          .expect(201)
      ).body.id as string;

    it('grants inMyUnits the direct units only, inMyUnitsAndBelow those below too, never the parent', async () => {
      const { admin, sales, northEast } = await tree();
      const memberOf = async (key: string, unitId: string) => {
        const created = await node.user([await readingWith(key)]);
        await admin
          .post(`/v1/access/organizational-units/${unitId}/members`)
          .send({ userId: created.id })
          .expect(201);
        return titles(created.agent);
      };
      expect(await memberOf('inMyUnits', sales)).toEqual(['From Sales']);
      expect(await memberOf('inMyUnitsAndBelow', sales)).toEqual([
        'From North East',
        'From Sales',
        'From South',
      ]);
      // A member of a child unit sees nothing of its parent's.
      expect(await memberOf('inMyUnitsAndBelow', northEast)).toEqual([
        'From North East',
      ]);
    });

    it('grants inUnitsILeadAndBelow to leads only, until their membership ends', async () => {
      const { admin, sales, north, northEast } = await tree();
      const [lead] = await node.roleIds('unit-lead');
      const user = async (unitId: string, role: 'member' | 'lead') => {
        const created = await node.user([lead]);
        const membership = await admin
          .post(`/v1/access/organizational-units/${unitId}/members`)
          .send({ userId: created.id, role })
          .expect(201);
        expect(membership.body).toMatchObject({ role, validTo: null });
        return created;
      };
      // A member, not its lead: nothing.
      expect(await titles((await user(sales, 'member')).agent)).toEqual([]);
      expect(await titles((await user(sales, 'lead')).agent)).toEqual([
        'From North East',
        'From Sales',
        'From South',
      ]);
      const northLead = await user(north, 'lead');
      expect(await titles(northLead.agent)).toEqual(['From North East']);

      // Promoted, then ended: the history stays, the grant goes at once.
      const promoted = await user(north, 'member');
      expect(await titles(promoted.agent)).toEqual([]);
      // The preview (#841) tells what the promotion would open, and changes nothing.
      const impact = await admin
        .post(
          `/v1/access/organizational-units/${north}/members/${promoted.id}/impact`,
        )
        .send({ role: 'lead' })
        .expect(200);
      expect(impact.body).toEqual({
        changes: [
          {
            userId: promoted.id,
            name: promoted.email,
            email: promoted.email,
            andBelow: { gains: [], loses: [] },
            ledAndBelow: {
              gains: expect.arrayContaining([north, northEast]),
              loses: [],
            },
          },
        ],
        truncated: false,
      });
      expect(await titles(promoted.agent)).toEqual([]);
      expect(
        await node.auditEntries({
          action: 'organizationalUnit.member-role-changed',
          targetId: north,
        }),
      ).toHaveLength(0);
      await admin
        .patch(
          `/v1/access/organizational-units/${north}/members/${promoted.id}`,
        )
        .send({ role: 'lead' })
        .expect(200);
      expect(await titles(promoted.agent)).toEqual(['From North East']);
      await admin
        .delete(
          `/v1/access/organizational-units/${north}/members/${northLead.id}`,
        )
        .expect(204);
      expect(await titles(northLead.agent)).toEqual([]);
      const history = (
        await admin
          .get(`/v1/access/organizational-units/${north}/members`)
          .expect(200)
      ).body.items as {
        userId: string;
        role: string;
        validTo: string | null;
      }[];
      expect(
        history
          .filter((row) => row.userId === promoted.id)
          .map((row) => row.role)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(['lead', 'member']);
      expect(
        history.find((row) => row.userId === northLead.id)?.validTo,
      ).not.toBeNull();
      // Nobody changes their own units.
      const me = (await admin.get('/v1/auth/me').expect(200)).body.user.id;
      await admin
        .post(`/v1/access/organizational-units/${north}/members`)
        .send({ userId: me, role: 'lead' })
        .expect(403);
    });

    it("sets a record's unit only when its owner is in exactly one unit", async () => {
      const { admin, sales, south } = await tree();
      const created = await node.user(['editor']);
      const item = async () =>
        (
          await node
            .writeItem(created.agent, { title: 't', body: 'x' })
            .expect(201)
        ).body.unitId as string | null;
      expect(await item()).toBeNull();
      await admin
        .post(`/v1/access/organizational-units/${south}/members`)
        .send({ userId: created.id })
        .expect(201);
      expect(await item()).toBe(south);
      await admin
        .post(`/v1/access/organizational-units/${sales}/members`)
        .send({ userId: created.id })
        .expect(201);
      expect(await item()).toBeNull();
    });

    it('keeps sibling names unique ignoring case, moves subtrees, and deletes only empty units', async () => {
      const { admin, sales, north, south, northEast } = await tree();
      const listed = (
        await admin.get('/v1/access/organizational-units').expect(200)
      ).body.items;
      expect(
        listed.find((u: { id: string }) => u.id === northEast),
      ).toMatchObject({ depth: 2, parentId: north, type: 'team' });

      // Beside a sibling of the same name (any case), and at the top: 409.
      const taken = await admin
        .post('/v1/access/organizational-units')
        .send({ type: 'team', name: 'north', parentId: sales })
        .expect(409);
      expect(taken.body.code).toBe('unit_name_taken');
      await admin
        .post('/v1/access/organizational-units')
        .send({ type: 'team', name: 'SALES' })
        .expect(409);
      await admin
        .patch(`/v1/access/organizational-units/${south}`)
        .send({ name: 'NORTH' })
        .expect(409);
      // Elsewhere in the tree, the same name is fine.
      const other = await admin
        .post('/v1/access/organizational-units')
        .send({ type: 'team', name: 'North', parentId: south })
        .expect(201);

      // Moving a subtree moves what is seen through it.
      const [lead] = await node.roleIds('unit-lead');
      const southLead = await node.user([lead]);
      await admin
        .post(`/v1/access/organizational-units/${south}/members`)
        .send({ userId: southLead.id, role: 'lead' })
        .expect(201);
      // The preview (#841) refuses what the move would refuse…
      const impact = (status: number) =>
        admin
          .post(`/v1/access/organizational-units/${north}/impact`)
          .send({ parentId: south, type: 'team' })
          .expect(status);
      expect((await impact(409)).body.code).toBe('unit_name_taken');
      // The type changes, the name clash under South goes first.
      await admin
        .delete(`/v1/access/organizational-units/${other.body.id}`)
        .expect(204);
      // …and tells who would reach what, without moving anything.
      const previewed = (await impact(200)).body as {
        changes: {
          userId: string;
          andBelow: { gains: string[]; loses: string[] };
          ledAndBelow: { gains: string[]; loses: string[] };
        }[];
      };
      expect(
        previewed.changes.find((change) => change.userId === southLead.id),
      ).toMatchObject({
        andBelow: { gains: expect.arrayContaining([north, northEast]) },
        ledAndBelow: {
          gains: expect.arrayContaining([north, northEast]),
          loses: [],
        },
      });
      expect(await titles(southLead.agent)).toEqual(['From South']);
      await admin
        .patch(`/v1/access/organizational-units/${north}`)
        .send({ parentId: south, type: 'team' })
        .expect(200);
      expect(await titles(southLead.agent)).toEqual([
        'From North East',
        'From South',
      ]);
      // Never under itself or a unit below it.
      await admin
        .patch(`/v1/access/organizational-units/${south}`)
        .send({ parentId: northEast })
        .expect(409);

      // Units under it, members or records: no cascade.
      const notEmpty = async (id: string) =>
        expect(
          (
            await admin
              .delete(`/v1/access/organizational-units/${id}`)
              .expect(409)
          ).body.code,
        ).toBe('unit_not_empty');
      await notEmpty(south); // units under it
      await notEmpty(northEast); // a member, and an item
      // Only an ended membership left: it goes with the unit.
      const empty = (
        await admin
          .post('/v1/access/organizational-units')
          .send({ type: 'department', name: 'Empty' })
          .expect(201)
      ).body.id as string;
      const passing = await node.user([]);
      await admin
        .post(`/v1/access/organizational-units/${empty}/members`)
        .send({ userId: passing.id })
        .expect(201);
      await notEmpty(empty);
      await admin
        .delete(
          `/v1/access/organizational-units/${empty}/members/${passing.id}`,
        )
        .expect(204);
      await admin
        .delete(`/v1/access/organizational-units/${empty}`)
        .expect(204);
    });
  });
});
