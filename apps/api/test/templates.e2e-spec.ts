import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { bootApp, type TestApp } from './support.js';

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

/** Record templates (docs/templates.md), on the test items. */
describe('record templates (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const draft = {
    subject: 'TestItem',
    name: 'Weekly status',
    values: { title: 'Weekly status', body: 'Done:\nNext:' },
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

  it('previews a template, and the record is then created through the normal route', async () => {
    const ann = await node.user(['editor']);
    const created = await ann.agent
      .post('/v1/templates')
      .send(draft)
      .expect(201);
    expect(created.body).toMatchObject({
      subject: 'TestItem',
      visibility: 'private',
      mine: true,
      editable: true,
      values: draft.values,
    });

    const preview = await ann.agent
      .get(`/v1/templates/${created.body.id}/preview`)
      .expect(200);
    expect(preview.body).toMatchObject({ values: draft.values, dropped: [] });

    // The prefill is a plain create body: the route validates it as any other.
    const record = await ann.agent
      .post('/v1/test-items')
      .set('Idempotency-Key', randomUUID())
      .send({ ...preview.body.values, code: 'W1' })
      .expect(201);
    expect(record.body).toMatchObject({ title: 'Weekly status', code: 'W1' });

    const subjects = await ann.agent.get('/v1/templates/subjects').expect(200);
    expect(
      subjects.body.items.find(
        (s: { subject: string }) => s.subject === 'TestItem',
      ).fields,
    ).toEqual(expect.arrayContaining(['title', 'body', 'custom']));
  });

  it('keeps private templates private, and refuses what is not a create field or is invalid', async () => {
    const ann = await node.user(['editor']);
    const bob = await node.user(['editor']);
    const made = await ann.agent.post('/v1/templates').send(draft).expect(201);
    await bob.agent.get(`/v1/templates/${made.body.id}`).expect(404);
    expect(
      (await bob.agent.get('/v1/templates').expect(200)).body.items,
    ).toEqual([]);
    await ann.agent.post('/v1/templates').send(draft).expect(409); // the name is taken

    const refused = async (values: Record<string, unknown>) =>
      paths(
        (
          await ann.agent
            .post('/v1/templates')
            .send({ ...draft, name: randomUUID(), values })
            .expect(400)
        ).body,
      );
    // System-set values and unknown keys are no create fields.
    expect(
      await refused({ id: randomUUID(), number: 'TI-1', ownerId: 'user:x' }),
    ).toEqual(['values.id', 'values.number', 'values.ownerId']);
    expect(await refused({ namingSeriesId: randomUUID() })).toEqual([
      'values.namingSeriesId',
    ]);
    expect(await refused({ title: 42 })).toEqual(['values.title']);
    await ann.agent
      .post('/v1/templates')
      .send({ ...draft, name: 'Nope', subject: 'Nothing' })
      .expect(400);
  });

  it('never lets a template set a field its user may not, when saved or previewed', async () => {
    const limited = await node.user([
      await role(
        node.admin(),
        ['TestItem', 'create', ['title']],
        ['Access', 'manageTemplates'],
      ),
    ]);
    const forbidden = await limited.agent
      .post('/v1/templates')
      .send(draft)
      .expect(403);
    expect(forbidden.body).toMatchObject({
      code: 'field_forbidden',
      fields: ['body'],
    });
    const mine = await limited.agent
      .post('/v1/templates')
      .send({ ...draft, values: { title: 'Only a title' } })
      .expect(201);

    // The administrator shares one that sets `body` with the tenant: for the limited user it is dropped.
    const wide = await node
      .admin()
      .post('/v1/templates')
      .send({ ...draft, name: 'Everyone', visibility: 'tenant' })
      .expect(201);
    const preview = await limited.agent
      .get(`/v1/templates/${wide.body.id}/preview`)
      .expect(200);
    expect(preview.body.values).toEqual({ title: 'Weekly status' });
    expect(preview.body.dropped).toEqual([
      expect.objectContaining({ field: 'body', reason: 'forbidden' }),
    ]);
    await limited.agent
      .get(`/v1/templates/${mine.body.id}/preview`)
      .expect(200);

    // Nobody who may not create the records sees or uses their templates.
    const reader = await node.user(['viewer']);
    await reader.agent.get(`/v1/templates/${wide.body.id}`).expect(404);
    await reader.agent
      .post('/v1/templates')
      .send({ ...draft, name: 'Read only' })
      .expect(403);
  });

  it('drops values a changed schema no longer takes, and says so (a stale template)', async () => {
    const ann = await node.user(['editor']);
    const field = await node
      .admin()
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
      })
      .expect(201);
    const made = await ann.agent
      .post('/v1/templates')
      .send({ ...draft, values: { title: 'T', custom: { region: 'eu' } } })
      .expect(201);
    // A choice that was never an option is refused when saving.
    expect(
      paths(
        (
          await ann.agent
            .post('/v1/templates')
            .send({
              ...draft,
              name: 'Bad choice',
              values: { custom: { region: 'asia' } },
            })
            .expect(400)
        ).body,
      ),
    ).toEqual(['values.custom.region']);

    expect(
      (await ann.agent.get(`/v1/templates/${made.body.id}/preview`).expect(200))
        .body.values,
    ).toEqual({ title: 'T', custom: { region: 'eu' } });

    await node.admin().delete(`/v1/custom-fields/${field.body.id}`).expect(204);
    const stale = await ann.agent
      .get(`/v1/templates/${made.body.id}/preview`)
      .expect(200);
    expect(stale.body.values).toEqual({ title: 'T' });
    expect(stale.body.dropped).toEqual([
      expect.objectContaining({ field: 'custom.region', reason: 'invalid' }),
    ]);
  });

  it('shares with the tenant only through Access.manageTemplates, and audits every change', async () => {
    const ann = await node.user(['editor']);
    const manager = await node.user([
      await role(
        node.admin(),
        ['Access', 'manageTemplates'],
        ['TestItem', 'create'],
      ),
    ]);
    await ann.agent
      .post('/v1/templates')
      .send({ ...draft, visibility: 'tenant' })
      .expect(403);

    const wide = await manager.agent
      .post('/v1/templates')
      .send({ ...draft, visibility: 'tenant' })
      .expect(201);
    const id = wide.body.id as string;
    const seen = await ann.agent.get(`/v1/templates/${id}`).expect(200);
    expect(seen.body).toMatchObject({ mine: false, editable: false });
    await ann.agent.delete(`/v1/templates/${id}`).expect(403);
    await ann.agent.get(`/v1/templates/${id}/preview`).expect(200);

    // A shared template changes through its owner or a manager, and every change is audited.
    await manager.agent
      .patch(`/v1/templates/${id}`)
      .send({ values: { title: 'Changed' } })
      .expect(200);
    await manager.agent.delete(`/v1/templates/${id}`).expect(204);
    expect(
      (await node.auditEntries({ targetId: id }))
        .map((entry) => entry.action)
        .sort(),
    ).toEqual([
      'recordTemplate.created',
      'recordTemplate.deleted',
      'recordTemplate.updated',
    ]);
  });
});
