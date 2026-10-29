import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { ChoicesRegistry } from '../src/platform/choices/choices.registry.js';
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

  it('validates conditions at save, and requires or strips answers by them on the server', async () => {
    const admin = node.admin();
    await enable(admin);
    // Version 1: format 1, no conditions; its submission stays readable as it was.
    const created = await admin
      .post('/v1/forms')
      .send({
        slug: `rules-${randomUUID().slice(0, 8)}`,
        name: 'Rules',
        definition: { ...definition, format: 1 },
      })
      .expect(201);
    const id = created.body.id as string;
    const v1 = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: created.body.revision })
      .expect(201);
    const filler = await node.user([await role(admin, 'read', 'submit')]);
    const first = await submit(filler.agent, id, {
      versionId: v1.body.id,
      answers: { full_name: 'Ada' },
    }).expect(201);

    const other = { field: 'topic', op: 'eq', value: 'other' };
    const fields = [
      ...definition.sections[0]!.fields,
      {
        key: 'details',
        type: 'textarea',
        label: 'Details',
        visibleWhen: other,
        requiredWhen: other,
      },
    ];
    const draft = (body: object) =>
      admin.put(`/v1/forms/${id}/draft`).send(body);
    const current = await admin.get(`/v1/forms/${id}/draft`).expect(200);
    // A condition on a later field (a cycle in the making), or on an option the field lacks.
    const refused = await draft({
      revision: current.body.revision,
      definition: {
        sections: [
          {
            key: 'contact',
            fields: [
              { ...fields[0], visibleWhen: { field: 'topic', op: 'isEmpty' } },
              ...fields.slice(1, 3),
              { ...fields[3], visibleWhen: { ...other, value: 'nope' } },
            ],
          },
        ],
      },
    }).expect(400);
    expect(paths(refused.body)).toEqual([
      'definition.sections.0.fields.0.visibleWhen.field',
      'definition.sections.0.fields.3.visibleWhen.value',
    ]);
    const saved = await draft({
      revision: current.body.revision,
      definition: { sections: [{ key: 'contact', fields }] },
    }).expect(200);
    const v2 = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: saved.body.revision })
      .expect(201);
    expect(v2.body.definition.format).toBe(4);

    const missing = await submit(filler.agent, id, {
      versionId: v2.body.id,
      answers: { full_name: 'Ada', topic: 'other' },
    }).expect(400);
    expect(paths(missing.body)).toEqual(['answers.details']);
    // Hidden (topic is billing): what a client sends for details is dropped.
    const stripped = await submit(filler.agent, id, {
      versionId: v2.body.id,
      answers: { full_name: 'Ada', topic: 'billing', details: 'sneaked' },
    }).expect(201);
    expect(stripped.body.answers).toEqual({
      full_name: 'Ada',
      topic: 'billing',
    });

    const old = await filler.agent
      .get(`/v1/forms/${id}/submissions/${first.body.id}`)
      .expect(200);
    expect(old.body).toMatchObject({
      version: 1,
      answers: { full_name: 'Ada' },
    });
    const oldVersion = await filler.agent
      .get(`/v1/forms/${id}/versions/1`)
      .expect(200);
    expect(oldVersion.body.definition.format).toBe(1);
  });

  it('checks a repeatable group item by item on the server, its pages and bounds at save', async () => {
    const admin = node.admin();
    await enable(admin);
    // Version 1: format 2; its submission stays readable once pages come.
    const created = await admin
      .post('/v1/forms')
      .send({
        slug: `steps-${randomUUID().slice(0, 8)}`,
        name: 'Steps',
        definition: { ...definition, format: 2 },
      })
      .expect(201);
    const id = created.body.id as string;
    const v1 = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: created.body.revision })
      .expect(201);
    const filler = await node.user([await role(admin, 'read', 'submit')]);
    const first = await submit(filler.agent, id, {
      versionId: v1.body.id,
      answers: { full_name: 'Ada', seats: 2 },
    }).expect(201);

    const people = {
      key: 'people',
      type: 'group',
      label: 'People',
      validation: { minItems: 1, maxItems: 2 },
      fields: [
        { key: 'who', type: 'text', label: 'Who', required: true },
        { key: 'age', type: 'integer', label: 'Age', validation: { max: 120 } },
      ],
    };
    const draft = (body: object) =>
      admin.put(`/v1/forms/${id}/draft`).send(body);
    const current = await admin.get(`/v1/forms/${id}/draft`).expect(200);
    // A group in a group, and a bound over the hard cap: refused at their paths.
    const team = (field: object) => ({
      revision: current.body.revision,
      definition: {
        sections: [
          definition.sections[0],
          { key: 'team', startsPage: true, fields: [field] },
        ],
      },
    });
    const nested = await draft(
      team({ ...people, fields: [{ ...people, key: 'inner' }] }),
    ).expect(400);
    expect(paths(nested.body)).toContain(
      'definition.sections.1.fields.0.fields.0.type',
    );
    const capped = await draft(
      team({ ...people, validation: { maxItems: 51 } }),
    ).expect(400);
    expect(paths(capped.body)).toEqual([
      'definition.sections.1.fields.0.validation.maxItems',
    ]);
    const saved = await draft({
      revision: current.body.revision,
      definition: {
        sections: [
          definition.sections[0],
          { key: 'team', startsPage: true, fields: [people] },
        ],
      },
    }).expect(200);
    const v2 = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: saved.body.revision })
      .expect(201);
    expect(v2.body.definition.format).toBe(4);
    expect(v2.body.definition.sections[1].startsPage).toBe(true);

    // Each item at its index, an unknown key in an item too.
    const wrong = await submit(filler.agent, id, {
      versionId: v2.body.id,
      answers: {
        full_name: 'Ada',
        people: [{ who: ' ' }, { who: 'Bo', age: 200, extra: 1 }],
      },
    }).expect(400);
    expect(paths(wrong.body)).toEqual([
      'answers.people.0.who',
      'answers.people.1.extra',
      'answers.people.1.age',
    ]);
    const tooMany = await submit(filler.agent, id, {
      versionId: v2.body.id,
      answers: {
        full_name: 'Ada',
        people: [{ who: 'a' }, { who: 'b' }, { who: 'c' }],
      },
    }).expect(400);
    expect(paths(tooMany.body)).toEqual(['answers.people']);
    const sent = await submit(filler.agent, id, {
      versionId: v2.body.id,
      answers: { full_name: 'Ada', people: [{ who: 'Bo', age: '4' }] },
    }).expect(201);
    expect(sent.body.answers).toEqual({
      full_name: 'Ada',
      people: [{ who: 'Bo', age: 4 }],
    });

    const old = await filler.agent
      .get(`/v1/forms/${id}/submissions/${first.body.id}`)
      .expect(200);
    expect(old.body).toMatchObject({
      version: 1,
      answers: { full_name: 'Ada', seats: 2 },
    });
    const oldVersion = await filler.agent
      .get(`/v1/forms/${id}/versions/1`)
      .expect(200);
    expect(oldVersion.body.definition.format).toBe(2);
  });

  it('takes choices from a registered source, checks each answer by it, and refuses others', async () => {
    const admin = node.admin();
    await enable(admin);
    // A provider of trusted code that filters by who asks (as a field-level
    // permission would): `secret` is the administrator's alone.
    node.app.get(ChoicesRegistry).provider({
      key: 'e2e-colors',
      label: 'Colors',
      params: {},
      mayUse: async (principal) => principal.kind === 'user',
      options: async ({ principal, q, limit }) =>
        [
          'blue',
          'red',
          ...(principal.kind === 'user' && principal.email.startsWith('admin')
            ? ['secret']
            : []),
        ]
          .filter((value) => !q || value.includes(q))
          .slice(0, limit)
          .map((value) => ({ value, label: value.toUpperCase() })),
      has: async ({ principal, value }) =>
        ['blue', 'red'].includes(value) ||
        (value === 'secret' &&
          principal.kind === 'user' &&
          principal.email.startsWith('admin')),
    });
    node.app.get(ChoicesRegistry).provider({
      key: 'e2e-slow',
      label: 'Slow',
      params: {},
      mayUse: async () => true,
      options: () => new Promise(() => {}),
      has: () => new Promise(() => {}),
    });
    const units = await admin
      .post('/v1/access/organizational-units')
      .send({ type: 'team', name: `unit-${randomUUID().slice(0, 6)}` })
      .expect(201);

    const sources = await admin.get('/v1/forms/option-sources').expect(200);
    expect(sources.body.items.map((item: { key: string }) => item.key)).toEqual(
      expect.arrayContaining(['organizational-units', 'e2e-colors']),
    );
    // A source with parameters isn't offered.
    expect(
      sources.body.items.map((item: { key: string }) => item.key),
    ).not.toContain('unit-members');

    const created = await admin
      .post('/v1/forms')
      .send({
        slug: `sources-${randomUUID().slice(0, 8)}`,
        name: 'Sources',
      })
      .expect(201);
    const id = created.body.id as string;
    const choice = (key: string, provider: string, type = 'select') => ({
      key,
      type,
      label: key,
      optionsSource: { provider },
    });
    // Unregistered, or taking parameters: refused at save.
    const refused = await admin
      .put(`/v1/forms/${id}/draft`)
      .send({
        revision: created.body.revision,
        definition: {
          sections: [
            {
              key: 'main',
              fields: [choice('a', 'https-evil'), choice('b', 'unit-members')],
            },
          ],
        },
      })
      .expect(400);
    expect(paths(refused.body)).toEqual([
      'definition.sections.0.fields.0.optionsSource.provider',
      'definition.sections.0.fields.1.optionsSource.provider',
    ]);
    const saved = await admin
      .put(`/v1/forms/${id}/draft`)
      .send({
        revision: created.body.revision,
        definition: {
          sections: [
            {
              key: 'main',
              fields: [
                { ...choice('unit', 'organizational-units'), required: true },
                choice('colors', 'e2e-colors', 'multiSelect'),
                choice('slow', 'e2e-slow'),
              ],
            },
          ],
        },
      })
      .expect(200);
    const version = await admin
      .post(`/v1/forms/${id}/publish`)
      .send({ revision: saved.body.revision })
      .expect(201);
    expect(version.body.definition.format).toBe(4);

    const filler = await node.user([await role(admin, 'read', 'submit')]);
    // The choices through the form, filtered to the filler, bounded.
    const colors = await filler.agent
      .get(`/v1/forms/${id}/options/colors?limit=1`)
      .expect(200);
    expect(colors.body).toEqual({
      field: 'colors',
      items: [{ value: 'blue', label: 'BLUE' }],
      hasMore: true,
    });
    const narrowed = await filler.agent
      .get(`/v1/forms/${id}/options/colors?q=re`)
      .expect(200);
    expect(narrowed.body.items).toEqual([{ value: 'red', label: 'RED' }]);
    const unitsSeen = await filler.agent
      .get(`/v1/forms/${id}/options/unit`)
      .expect(200);
    expect(unitsSeen.body.items).toContainEqual({
      value: units.body.id,
      label: units.body.name,
    });
    // Only a field's own source, never one by name; a limit over 50 is refused.
    await filler.agent.get(`/v1/forms/${id}/options/nope`).expect(404);
    await filler.agent
      .get(`/v1/forms/${id}/options/colors?limit=51`)
      .expect(400);
    // A slow source: a 503, not a hang.
    const slow = await filler.agent
      .get(`/v1/forms/${id}/options/slow`)
      .expect(503);
    expect(slow.body.code).toBe('form_source_unavailable');

    // Values checked by the source, never a label; another's choice refused.
    const wrong = await submit(filler.agent, id, {
      versionId: version.body.id,
      answers: { unit: randomUUID(), colors: ['BLUE', 'secret'] },
    }).expect(400);
    expect(paths(wrong.body)).toEqual([
      'answers.unit',
      'answers.colors.0',
      'answers.colors.1',
    ]);
    const sent = await submit(filler.agent, id, {
      versionId: version.body.id,
      answers: { unit: units.body.id, colors: ['red'] },
    }).expect(201);
    expect(sent.body.answers).toEqual({ unit: units.body.id, colors: ['red'] });

    // Another tenant's unit is no choice here (row-level security).
    const other = await node.otherTenant();
    const theirs = await other.admin
      .post('/v1/access/organizational-units')
      .send({ type: 'team', name: 'theirs' })
      .expect(201);
    const foreign = await submit(filler.agent, id, {
      versionId: version.body.id,
      answers: { unit: theirs.body.id },
    }).expect(400);
    expect(paths(foreign.body)).toEqual(['answers.unit']);

    // A client may submit forms, not use a source made for users: 403.
    const [submitter] = [await role(admin, 'read', 'submit')];
    const client = await admin
      .post('/v1/access/clients')
      .send({ name: `forms-${randomUUID().slice(0, 8)}`, roleIds: [submitter] })
      .expect(201);
    const denied = await node
      .http()
      .get(`/v1/forms/${id}/options/unit`)
      .set('Authorization', `Bearer ${client.body.key}`)
      .expect(403);
    expect(denied.body.code).toBe('form_source_forbidden');
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
