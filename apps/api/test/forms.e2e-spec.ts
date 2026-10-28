import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { bootApp, type TestApp } from './support.js';

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

describe('forms (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const definition = {
    sections: [
      {
        key: 'contact',
        title: 'Contact',
        fields: [
          { key: 'full_name', type: 'text', label: 'Name', required: true },
          {
            key: 'topic',
            type: 'select',
            label: 'Topic',
            options: [
              { value: 'billing', label: 'Billing' },
              { value: 'other', label: 'Something else' },
            ],
          },
          {
            key: 'seats',
            type: 'integer',
            label: 'Seats',
            validation: { min: 1, max: 10 },
          },
        ],
      },
    ],
  };

  const enable = (admin: request.Agent) =>
    admin.put('/v1/settings/forms.enabled').send({ value: true }).expect(200);

  /** A role of these Form actions, by id. */
  async function role(by: request.Agent, ...actions: string[]) {
    const created = await by
      .post('/v1/access/roles')
      .send({
        name: `forms-${randomUUID().slice(0, 8)}`,
        permissions: actions.map((action) => ({
          subject: 'Form',
          action,
          conditions: [],
        })),
      })
      .expect(201);
    return created.body.id as string;
  }

  /** A published form of `definition`: its id and published version id. */
  async function published(admin: request.Agent) {
    const created = await admin
      .post('/v1/forms')
      .send({
        slug: `intake-${randomUUID().slice(0, 8)}`,
        name: 'Intake',
        definition,
      })
      .expect(201);
    const id = created.body.id as string;
    const version = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: created.body.revision })
      .expect(201);
    return { id, versionId: version.body.id as string };
  }

  const submit = (
    agent: request.Agent,
    formId: string,
    body: object,
    key = randomUUID(),
  ) =>
    agent
      .post(`/v1/forms/${formId}/submissions`)
      .set('Idempotency-Key', key)
      .send(body);

  it('answers 404 until the tenant turns forms on', async () => {
    const admin = node.admin();
    await admin.get('/v1/forms').expect(404);
    await enable(admin);
    expect((await admin.get('/v1/forms').expect(200)).body.items).toEqual([]);
  });

  it('edits a draft under its revision, publishes immutable versions and keeps a published key’s type', async () => {
    const admin = node.admin();
    await enable(admin);
    const created = await admin
      .post('/v1/forms')
      .send({ slug: 'incident-report', name: 'Incident report' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({
      status: 'active',
      publishedVersion: null,
    });
    // The slug is unique in the tenant.
    const taken = await admin
      .post('/v1/forms')
      .send({ slug: 'incident-report', name: 'Again' })
      .expect(409);
    expect(taken.body.code).toBe('form_slug_taken');
    // Nothing to publish yet.
    const empty = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: created.body.revision })
      .expect(400);
    expect(paths(empty.body)).toContain('definition.sections');

    const saved = await admin
      .put(`/v1/forms/${id}/draft`)
      .send({ revision: created.body.revision, definition })
      .expect(200);
    // An editor working from the old revision is refused, not overwritten.
    const stale = await admin
      .put(`/v1/forms/${id}/draft`)
      .send({ revision: created.body.revision, definition })
      .expect(409);
    expect(stale.body.code).toBe('form_conflict');
    // A schema that breaks its own rules: the path says where.
    const invalid = await admin
      .put(`/v1/forms/${id}/draft`)
      .send({
        revision: saved.body.revision,
        definition: {
          sections: [
            {
              key: 'contact',
              fields: [
                { key: 'Bad Key', type: 'text', label: 'Name' },
                { key: 'pick', type: 'select', label: 'Pick' },
              ],
            },
          ],
        },
      })
      .expect(400);
    expect(paths(invalid.body).length).toBeGreaterThan(0);

    const first = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: saved.body.revision })
      .expect(201);
    expect(first.body).toMatchObject({ version: 1 });
    const again = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: saved.body.revision })
      .expect(409);
    expect(again.body.code).toBe('form_unchanged');

    // Once published, `seats` stays an integer: a draft that retypes it is refused.
    const refused = await admin
      .put(`/v1/forms/${id}/draft`)
      .send({
        revision: saved.body.revision,
        definition: {
          sections: [
            {
              ...definition.sections[0],
              fields: [
                definition.sections[0]!.fields[0],
                { key: 'seats', type: 'text', label: 'Seats' },
              ],
            },
          ],
        },
      })
      .expect(400);
    expect(paths(refused.body)).toEqual([
      'definition.sections.0.fields.1.type',
    ]);

    // Version 1 is as it was published.
    const v1 = await admin.get(`/v1/forms/${id}/versions/1`).expect(200);
    expect(v1.body.definition.sections[0].fields).toHaveLength(3);
    // A published form isn't deleted: it is archived.
    const deleted = await admin.delete(`/v1/forms/${id}`).expect(409);
    expect(deleted.body.code).toBe('form_published');
  });

  it('takes answers checked against the exact published version, once per Idempotency-Key', async () => {
    const admin = node.admin();
    await enable(admin);
    const { id, versionId } = await published(admin);
    const filler = await node.user([await role(admin, 'read', 'submit')]);

    const shown = await filler.agent
      .get(`/v1/forms/${id}/published`)
      .expect(200);
    expect(shown.body).toMatchObject({ versionId, version: 1 });

    const wrong = await submit(filler.agent, id, {
      versionId,
      answers: { topic: 'nope', seats: 11, extra: 'x' },
    }).expect(400);
    expect(paths(wrong.body)).toEqual(
      expect.arrayContaining([
        'answers.full_name',
        'answers.topic',
        'answers.seats',
        'answers.extra',
      ]),
    );

    const key = randomUUID();
    const body = {
      versionId,
      answers: { full_name: 'Ada', topic: 'billing', seats: 2 },
    };
    const sent = await submit(filler.agent, id, body, key).expect(201);
    const replayed = await submit(filler.agent, id, body, key).expect(201);
    expect(replayed.body.id).toBe(sent.body.id);
    expect(sent.body).toMatchObject({ versionId, version: 1 });

    // A new version: answers to the old one are refused, the old submission still reads as v1.
    const draft = await admin.get(`/v1/forms/${id}/draft`).expect(200);
    const changed = await admin
      .put(`/v1/forms/${id}/draft`)
      .send({
        revision: draft.body.revision,
        definition: {
          sections: [
            {
              ...definition.sections[0],
              fields: [
                ...definition.sections[0]!.fields,
                { key: 'notes', type: 'textarea', label: 'Notes' },
              ],
            },
          ],
        },
      })
      .expect(200);
    await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: changed.body.revision })
      .expect(201);
    const outdated = await submit(filler.agent, id, body).expect(409);
    expect(outdated.body.code).toBe('form_version_outdated');
    const kept = await filler.agent
      .get(`/v1/forms/${id}/submissions/${sent.body.id}`)
      .expect(200);
    expect(kept.body).toMatchObject({ version: 1, answers: body.answers });
  });

  it('shows a submitter their own submissions, everyone’s only to those who read responses', async () => {
    const admin = node.admin();
    await enable(admin);
    const { id, versionId } = await published(admin);
    const submitter = await role(admin, 'read', 'submit');
    const ada = await node.user([submitter]);
    const bob = await node.user([submitter]);
    const reviewer = await node.user([
      await role(admin, 'read', 'readResponses'),
    ]);
    const reader = await node.user([await role(admin, 'read')]);

    const answers = { full_name: 'Ada' };
    const mine = await submit(ada.agent, id, { versionId, answers }).expect(
      201,
    );
    await submit(bob.agent, id, {
      versionId,
      answers: { full_name: 'Bob' },
    }).expect(201);

    const own = await ada.agent.get(`/v1/forms/${id}/submissions`).expect(200);
    expect(own.body.items.map((s: { id: string }) => s.id)).toEqual([
      mine.body.id,
    ]);
    await bob.agent
      .get(`/v1/forms/${id}/submissions/${mine.body.id}`)
      .expect(404);
    const all = await reviewer.agent
      .get(`/v1/forms/${id}/submissions`)
      .expect(200);
    expect(all.body.items).toHaveLength(2);
    // Reading forms is not reading answers, nor submitting.
    await reader.agent.get(`/v1/forms/${id}/submissions`).expect(403);
    await submit(reader.agent, id, { versionId, answers }).expect(403);
    // Editing forms takes its own right.
    await reviewer.agent
      .post('/v1/forms')
      .send({ slug: 'nope', name: 'Nope' })
      .expect(403);
    // The audit says who submitted, never what.
    const audited = (
      await admin
        .get(`/v1/access/audit?action=form.submitted&targetId=${mine.body.id}`)
        .expect(200)
    ).body.items as { details: Record<string, unknown> }[];
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0]!.details)).not.toContain('Ada');
  });

  it('keeps another tenant’s forms and answers out of reach, even by id', async () => {
    const admin = node.admin();
    await enable(admin);
    const { id, versionId } = await published(admin);
    const other = await node.otherTenant();
    await enable(other.admin);
    await other.admin.get(`/v1/forms/${id}`).expect(404);
    await other.admin.get(`/v1/forms/${id}/published`).expect(404);
    await other.admin.get(`/v1/forms/${id}/submissions`).expect(404);
    await submit(other.admin, id, {
      versionId,
      answers: { full_name: 'Eve' },
    }).expect(404);
    expect((await other.admin.get('/v1/forms').expect(200)).body.items).toEqual(
      [],
    );
  });
});
