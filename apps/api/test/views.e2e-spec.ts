import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { bootApp, type TestApp } from './support.js';

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

/** Saved views of lists (docs/saved-views.md), on the test items' list. */
describe('saved views (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const draft = {
    subject: 'TestItem',
    name: 'Mine to do',
    query: { 'title.contains': 'plan', sort: '-createdAt' },
    columns: ['title', 'createdAt'],
  };

  /** A role of these permissions (no conditions), by id. */
  async function role(
    by: request.Agent,
    ...grants: [string, string, string[]?][]
  ) {
    const created = await by
      .post('/v1/access/roles')
      .send({
        name: `role-${randomUUID().slice(0, 8)}`,
        permissions: grants.map(([subject, action, fields]) => ({
          subject,
          action,
          conditions: [],
          ...(fields && { fields }),
        })),
      })
      .expect(201);
    return created.body.id as string;
  }

  /** A unit made by the administrator, with these users in it. */
  async function unit(...members: { id: string }[]) {
    const created = await node
      .admin()
      .post('/v1/access/organizational-units')
      .send({ type: 'team', name: `unit-${randomUUID().slice(0, 6)}` })
      .expect(201);
    for (const member of members) {
      await node
        .admin()
        .post(`/v1/access/organizational-units/${created.body.id}/members`)
        .send({ userId: member.id })
        .expect(201);
    }
    return created.body.id as string;
  }

  it('saves a private view, reads it back, and shows it to nobody else', async () => {
    const ann = await node.user(['editor']);
    const bob = await node.user(['editor']);

    const created = await ann.agent.post('/v1/views').send(draft).expect(201);
    expect(created.body).toMatchObject({
      subject: 'TestItem',
      name: 'Mine to do',
      visibility: 'private',
      unitId: null,
      mine: true,
      editable: true,
      query: draft.query,
      columns: draft.columns,
    });
    const id = created.body.id as string;

    await ann.agent.get(`/v1/views/${id}`).expect(200);
    const listed = await ann.agent
      .get('/v1/views?subject=TestItem')
      .expect(200);
    expect(listed.body.items.map((v: { id: string }) => v.id)).toEqual([id]);

    // Another user: not in their list, a 404 by id (not a hint that it exists).
    const theirs = await bob.agent.get('/v1/views').expect(200);
    expect(theirs.body.items).toEqual([]);
    await bob.agent.get(`/v1/views/${id}`).expect(404);
    await bob.agent.patch(`/v1/views/${id}`).send({ name: 'x' }).expect(404);
    await bob.agent.delete(`/v1/views/${id}`).expect(404);

    await ann.agent
      .patch(`/v1/views/${id}`)
      .send({ name: 'Renamed', columns: null })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ name: 'Renamed', columns: null });
        expect(body.query).toEqual(draft.query);
      });
    await ann.agent.delete(`/v1/views/${id}`).expect(204);
    await ann.agent.get(`/v1/views/${id}`).expect(404);
  });

  it('keeps names unique per list and place, whatever the case, and per place only', async () => {
    const ann = await node.user(['editor']);
    const bob = await node.user(['editor']);
    await ann.agent.post('/v1/views').send(draft).expect(201);
    const clash = await ann.agent
      .post('/v1/views')
      .send({ ...draft, name: 'MINE TO DO' })
      .expect(409);
    expect(clash.body.code).toBe('conflict');
    // Someone else's private view of the same name is another place.
    await bob.agent.post('/v1/views').send(draft).expect(201);
    // A rename onto a taken name is refused too.
    const other = await ann.agent
      .post('/v1/views')
      .send({ ...draft, name: 'Other' })
      .expect(201);
    await ann.agent
      .patch(`/v1/views/${other.body.id}`)
      .send({ name: 'mine to do' })
      .expect(409);
  });

  it('validates the query and columns against the list when saving', async () => {
    const ann = await node.user(['editor']);
    const refused = async (body: object) =>
      (await ann.agent.post('/v1/views').send(body).expect(400)).body;

    expect(paths(await refused({ ...draft, subject: 'Nothing' }))).toEqual([
      'subject',
    ]);
    expect(
      paths(await refused({ ...draft, query: { nope: 'x' } })),
    ).toHaveLength(1);
    expect(
      paths(
        await refused({
          ...draft,
          query: { 'title.contains': 'x', sort: 'nope' },
        }),
      ),
    ).toEqual(['query.sort']);
    // Paging, columns, the recycle bin and the language are not filters.
    for (const key of [
      'limit',
      'cursor',
      'page',
      'fields',
      'deleted',
      'lang',
    ]) {
      expect(paths(await refused({ ...draft, query: { [key]: '1' } }))).toEqual(
        [`query.${key}`],
      );
    }
    expect(
      paths(await refused({ ...draft, columns: ['title', 'nope'] })),
    ).toEqual(['columns']);
    // A unit view names its unit, and only it.
    await ann.agent
      .post('/v1/views')
      .send({ ...draft, visibility: 'unit' })
      .expect(400);
    await ann.agent
      .post('/v1/views')
      .send({ ...draft, unitId: randomUUID() })
      .expect(400);
    await ann.agent
      .post('/v1/views')
      .send({ ...draft, name: '' })
      .expect(400);

    // The advanced `filter` tree is a view's too.
    await ann.agent
      .post('/v1/views')
      .send({
        ...draft,
        name: 'Tree',
        query: {
          filter: JSON.stringify({
            or: [{ field: 'title', op: 'contains', value: 'a' }],
          }),
        },
      })
      .expect(201);
  });

  it('shares with a unit its members (not others) see, and only members may share with it', async () => {
    const ann = await node.user(['editor']);
    const bob = await node.user(['editor']);
    const cat = await node.user(['editor']);
    const unitId = await unit(ann, bob);

    // Cat is no member: not hers to share with.
    await cat.agent
      .post('/v1/views')
      .send({ ...draft, visibility: 'unit', unitId })
      .expect(403);
    const missing = await ann.agent
      .post('/v1/views')
      .send({ ...draft, visibility: 'unit', unitId: randomUUID() })
      .expect(400);
    expect(paths(missing.body)).toEqual(['unitId']);

    const shared = await ann.agent
      .post('/v1/views')
      .send({ ...draft, visibility: 'unit', unitId })
      .expect(201);
    expect(shared.body).toMatchObject({ visibility: 'unit', unitId });
    const id = shared.body.id as string;

    // A member sees it but doesn't own it.
    const seen = await bob.agent.get(`/v1/views/${id}`).expect(200);
    expect(seen.body).toMatchObject({ mine: false, editable: false });
    expect(
      (await bob.agent.get('/v1/views').expect(200)).body.items,
    ).toHaveLength(1);
    await bob.agent.patch(`/v1/views/${id}`).send({ name: 'x' }).expect(403);
    await bob.agent.delete(`/v1/views/${id}`).expect(403);
    await bob.agent.get(`/v1/views/${id}/apply`).expect(200);

    // A non-member doesn't.
    expect((await cat.agent.get('/v1/views').expect(200)).body.items).toEqual(
      [],
    );
    await cat.agent.get(`/v1/views/${id}`).expect(404);

    // The owner takes it back to private.
    await ann.agent
      .patch(`/v1/views/${id}`)
      .send({ visibility: 'private' })
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ visibility: 'private', unitId: null }),
      );
    await bob.agent.get(`/v1/views/${id}`).expect(404);

    // A unit with views shared with it stays (an administrator shares with one nobody is in).
    const empty = await unit();
    const again = await node
      .admin()
      .post('/v1/views')
      .send({ ...draft, name: 'Again', visibility: 'unit', unitId: empty })
      .expect(201);
    const kept = await node
      .admin()
      .delete(`/v1/access/organizational-units/${empty}`)
      .expect(409);
    expect(kept.body.code).toBe('unit_not_empty');
    await node.admin().delete(`/v1/views/${again.body.id}`).expect(204);
    await node
      .admin()
      .delete(`/v1/access/organizational-units/${empty}`)
      .expect(204);
  });

  it('shares with the tenant only through Access.manageViews, which also changes shared views', async () => {
    const ann = await node.user(['editor']);
    const manager = await node.user([
      await role(node.admin(), ['Access', 'manageViews'], ['TestItem', 'read']),
    ]);

    await ann.agent
      .post('/v1/views')
      .send({ ...draft, visibility: 'tenant' })
      .expect(403);
    const mine = await ann.agent.post('/v1/views').send(draft).expect(201);
    await ann.agent
      .patch(`/v1/views/${mine.body.id}`)
      .send({ visibility: 'tenant' })
      .expect(403);

    const wide = await manager.agent
      .post('/v1/views')
      .send({ ...draft, name: 'Everyone', visibility: 'tenant' })
      .expect(201);
    const id = wide.body.id as string;
    // Everyone who may read the list sees it, none may change it.
    const seen = await ann.agent.get(`/v1/views/${id}`).expect(200);
    expect(seen.body).toMatchObject({ mine: false, editable: false });
    await ann.agent.delete(`/v1/views/${id}`).expect(403);

    // A manager changes another's shared view, but not their private one.
    const shared = await ann.agent
      .post('/v1/views')
      .send({
        ...draft,
        name: 'Ann shares',
        visibility: 'unit',
        unitId: await unit(ann),
      })
      .expect(201);
    await manager.agent
      .patch(`/v1/views/${shared.body.id}`)
      .send({ name: 'Renamed by a manager' })
      .expect(404); // a unit view of a unit the manager isn't in is not theirs to see
    await manager.agent
      .patch(`/v1/views/${mine.body.id}`)
      .send({ name: 'x' })
      .expect(404);
    await manager.agent
      .patch(`/v1/views/${id}`)
      .send({ name: 'Renamed' })
      .expect(200);
    await manager.agent.delete(`/v1/views/${id}`).expect(204);
  });

  it('does not show views of lists the viewer may not read, nor let them be saved', async () => {
    const ann = await node.user(['editor']);
    const nobody = await node.user([
      await role(node.admin(), ['Access', 'manageViews']),
    ]);
    const wide = await nobody.agent
      .post('/v1/views')
      .send({ ...draft, visibility: 'tenant' });
    expect(wide.status).toBe(403); // may not read TestItem

    const made = await node
      .admin()
      .post('/v1/views')
      .send({ ...draft, name: 'Wide', visibility: 'tenant' })
      .expect(201);
    expect(
      (await nobody.agent.get('/v1/views').expect(200)).body.items,
    ).toEqual([]);
    await nobody.agent.get(`/v1/views/${made.body.id}`).expect(404);
    await ann.agent.get(`/v1/views/${made.body.id}`).expect(200);
  });

  it('applies a view: its params for the list route, columns the viewer may not see left out', async () => {
    const admin = node.admin();
    const created = await admin
      .post('/v1/views')
      .send({
        ...draft,
        name: 'Wide',
        visibility: 'tenant',
        columns: ['title', 'body', 'createdAt'],
      })
      .expect(201);
    const id = created.body.id as string;

    const full = await admin.get(`/v1/views/${id}/apply`).expect(200);
    expect(full.body).toMatchObject({
      params: {
        'title.contains': 'plan',
        sort: '-createdAt',
        fields: 'title,body,createdAt',
      },
      columns: ['title', 'body', 'createdAt'],
      hiddenColumns: [],
    });

    // May read the items but not their body: hidden, not an error.
    const reader = await node.user([
      await role(admin, ['TestItem', 'read', ['custom']]),
    ]);
    const limited = await reader.agent.get(`/v1/views/${id}/apply`).expect(200);
    expect(limited.body).toMatchObject({
      params: { fields: 'title,createdAt' },
      columns: ['title', 'createdAt'],
      hiddenColumns: ['body'],
    });
    expect(limited.body.view.columns).toEqual(['title', 'createdAt']);

    // The params are what the list route takes.
    await reader.agent
      .get('/v1/test-items')
      .query(limited.body.params as Record<string, string>)
      .expect(200);
  });

  it('refuses a filter on a field the viewer may not read, when saving and when applying', async () => {
    const admin = node.admin();
    const filtered = {
      ...draft,
      name: 'By body',
      visibility: 'tenant',
      query: { 'body.contains': 'secret' },
      columns: null,
    };
    const created = await admin.post('/v1/views').send(filtered).expect(201);
    const reader = await node.user([
      await role(admin, ['TestItem', 'read', ['custom']]),
    ]);
    const refused = await reader.agent
      .get(`/v1/views/${created.body.id}/apply`)
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'field_forbidden',
      fields: ['body'],
    });
    await reader.agent
      .post('/v1/views')
      .send({ ...filtered, visibility: 'private', name: 'Mine' })
      .expect(403);
  });

  it('is applied against the list as it is now: a custom field removed makes the view stale (400)', async () => {
    const admin = node.admin();
    const field = await admin
      .post('/v1/custom-fields')
      .send({
        subject: 'TestItem',
        key: 'region',
        label: 'Region',
        type: 'select',
        options: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'Americas' },
        ],
        filterable: true,
      })
      .expect(201);
    const made = await admin
      .post('/v1/views')
      .send({
        ...draft,
        name: 'By region',
        visibility: 'tenant',
        query: { 'custom.region.in': 'us' },
        columns: ['title', 'custom.region'],
      })
      .expect(201);
    await admin.get(`/v1/views/${made.body.id}/apply`).expect(200);

    await admin
      .patch(`/v1/custom-fields/${field.body.id}`)
      .send({ active: false })
      .expect(200);
    const stale = await admin
      .get(`/v1/views/${made.body.id}/apply`)
      .expect(400);
    expect(stale.body.code).toBe('validation_failed');
    expect(paths(stale.body)).toEqual(['query.custom.region.in', 'columns']);
  });

  it('works for API clients (their own, private) and audits every change', async () => {
    const client = await node.client();
    const created = await node
      .http()
      .post('/v1/views')
      .set('Authorization', client.auth)
      .send({ ...draft, visibility: 'tenant' });
    expect(created.status).toBe(403); // sharing is for users

    const own = await node
      .http()
      .post('/v1/views')
      .set('Authorization', client.auth)
      .send(draft)
      .expect(201);
    expect(own.body.owner).toBe(`client:${client.id}`);
    expect(
      (await node.admin().get('/v1/views').expect(200)).body.items,
    ).toEqual([]);

    const ann = await node.user(['editor']);
    const view = await ann.agent.post('/v1/views').send(draft).expect(201);
    await ann.agent
      .patch(`/v1/views/${view.body.id}`)
      .send({ name: 'Two' })
      .expect(200);
    await ann.agent.delete(`/v1/views/${view.body.id}`).expect(204);
    const actions = (
      await node.auditEntries({ targetId: view.body.id as string })
    ).map((entry) => entry.action);
    expect(actions.sort()).toEqual([
      'view.created',
      'view.deleted',
      'view.updated',
    ]);
  });

  it('caps the views per owner', async () => {
    const ann = await node.user(['editor']);
    for (let index = 0; index < 100; index++) {
      await ann.agent
        .post('/v1/views')
        .send({ ...draft, name: `v${index}` })
        .expect(201);
    }
    const over = await ann.agent
      .post('/v1/views')
      .send({ ...draft, name: 'one too many' })
      .expect(400);
    expect(paths(over.body)).toEqual(['name']);
    expect(
      (await ann.agent.get('/v1/views?limit=100&count=true').expect(200)).body,
    ).toMatchObject({ total: 100 });
  });
});
