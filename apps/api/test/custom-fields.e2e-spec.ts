import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type request from 'supertest';
import { TestItemsService } from './fixtures/test-items/test-items.service.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { bootApp, type TestApp } from './support.js';

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('custom fields (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A role of these permissions (no conditions), by id. */
  async function role(...permissions: [string, string, string[]?][]) {
    const created = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `role-${randomUUID().slice(0, 8)}`,
        permissions: permissions.map(([subject, action, fields]) => ({
          subject,
          action,
          conditions: [],
          ...(fields && { fields }),
        })),
      })
      .expect(201);
    return created.body.id as string;
  }

  /** Adds a field to TestItem as the administrator. */
  async function field(definition: Record<string, unknown>) {
    const created = await node
      .admin()
      .post('/v1/custom-fields')
      .send({
        subject: 'TestItem',
        label: String(definition.key),
        ...definition,
      })
      .expect(201);
    return created.body as { id: string; key: string };
  }

  /** The `errors` paths of a problem response. */
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);

  /** A transfer's final state, polled. */
  async function finished(id: string, auth: string | request.Agent) {
    for (let tries = 0; tries < 100; tries++) {
      const status = await (
        typeof auth === 'string'
          ? node
              .http()
              .get(`/v1/data/transfers/${id}`)
              .set('Authorization', auth)
          : auth.get(`/v1/data/transfers/${id}`)
      ).expect(200);
      if (['completed', 'failed'].includes(status.body.status)) {
        return status.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The transfer never finished');
  }

  it('lets managers define fields, and anyone who reads the subject list them', async () => {
    const manager = await node.user([
      await role(['Access', 'manageCustomFields']),
    ]);
    const editor = await node.user(['editor']);
    const outsider = await node.user([await role(['Ops', 'view'])]);
    const client = await node.client();

    const created = await manager.agent
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
    expect(created.body).toMatchObject({
      subject: 'TestItem',
      key: 'region',
      type: 'select',
      required: false,
      default: null,
      position: 0,
      active: true,
    });

    // Changing definitions: Access.manageCustomFields, users only.
    await editor.agent
      .post('/v1/custom-fields')
      .send({ subject: 'TestItem', key: 'x', label: 'X', type: 'text' })
      .expect(403);
    await node
      .http()
      .post('/v1/custom-fields')
      .set('Authorization', client.auth)
      .send({ subject: 'TestItem', key: 'x', label: 'X', type: 'text' })
      .expect(403);
    await editor.agent
      .patch(`/v1/custom-fields/${created.body.id}`)
      .send({ label: 'Nope' })
      .expect(403);
    await editor.agent
      .delete(`/v1/custom-fields/${created.body.id}`)
      .expect(403);

    // Reading them: whoever may read test items (users and clients), or manages them.
    for (const agent of [editor.agent, manager.agent]) {
      const listed = await agent
        .get('/v1/custom-fields?subject=TestItem')
        .expect(200);
      expect(listed.body.items.map((f: { key: string }) => f.key)).toEqual([
        'region',
      ]);
    }
    await node
      .http()
      .get('/v1/custom-fields?subject=TestItem')
      .set('Authorization', client.auth)
      .expect(200);
    await outsider.agent.get('/v1/custom-fields?subject=TestItem').expect(403);
    await manager.agent.get('/v1/custom-fields?subject=Nope').expect(404);
    await manager.agent
      .post('/v1/custom-fields')
      .send({ subject: 'Nope', key: 'x', label: 'X', type: 'text' })
      .expect(404);

    // Keys: slugs, unique per subject, never changed.
    await manager.agent
      .post('/v1/custom-fields')
      .send({
        subject: 'TestItem',
        key: 'region',
        label: 'Again',
        type: 'text',
      })
      .expect(409);
    await manager.agent
      .post('/v1/custom-fields')
      .send({ subject: 'TestItem', key: 'Bad Key', label: 'X', type: 'text' })
      .expect(400);
    await manager.agent
      .patch(`/v1/custom-fields/${created.body.id}`)
      .send({ key: 'other' })
      .expect(400);

    // What the type doesn't take is refused, by name.
    const invalid = async (body: Record<string, unknown>, path: string) => {
      const response = await manager.agent
        .post('/v1/custom-fields')
        .send({
          subject: 'TestItem',
          label: 'X',
          key: `k${randomUUID().slice(0, 6)}`,
          ...body,
        })
        .expect(400);
      expect(paths(response.body)).toContain(path);
    };
    await invalid({ type: 'select' }, 'options');
    // An import file lists a multiSelect's choices separated by commas.
    await invalid(
      { type: 'multiSelect', options: [{ value: 'a,b', label: 'A or B' }] },
      'options.0.value',
    );
    await invalid(
      { type: 'text', options: [{ value: 'a', label: 'A' }] },
      'options',
    );
    await invalid({ type: 'text', validation: { min: 1 } }, 'validation.min');
    await invalid(
      { type: 'text', validation: { pattern: '(' } },
      'validation.pattern',
    );
    await invalid({ type: 'number', default: 'ten' }, 'default');
    await invalid(
      { type: 'number', validation: { min: 5, max: 1 } },
      'validation.min',
    );

    // Change, reorder, deactivate: each audited.
    const second = await manager.agent
      .post('/v1/custom-fields')
      .send({ subject: 'TestItem', key: 'due', label: 'Due', type: 'date' })
      .expect(201);
    expect(second.body.position).toBe(1);
    await manager.agent
      .patch(`/v1/custom-fields/${created.body.id}`)
      .send({ label: 'Sales region' })
      .expect(200);
    const reordered = await manager.agent
      .put('/v1/custom-fields/order')
      .send({ subject: 'TestItem', ids: [second.body.id] })
      .expect(200);
    expect(reordered.body.items.map((f: { key: string }) => f.key)).toEqual([
      'due',
      'region',
    ]);
    await manager.agent
      .delete(`/v1/custom-fields/${second.body.id}`)
      .expect(204);
    const active = await editor.agent
      .get('/v1/custom-fields?subject=TestItem')
      .expect(200);
    expect(active.body.items.map((f: { key: string }) => f.key)).toEqual([
      'region',
    ]);
    const all = await editor.agent
      .get('/v1/custom-fields?subject=TestItem&includeInactive=true')
      .expect(200);
    expect(all.body.items.map((f: { key: string }) => f.key)).toEqual([
      'due',
      'region',
    ]);

    const audit = await node
      .admin()
      .get(
        `/v1/access/audit?action=customField.updated&targetId=${created.body.id}`,
      )
      .expect(200);
    expect(audit.body.items[0].details.changes.label).toEqual({
      from: 'Region',
      to: 'Sales region',
    });
    const actions = (
      await node.admin().get('/v1/access/audit?action.startsWith=customField.')
    ).body.items.map((entry: { action: string }) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'customField.created',
        'customField.updated',
        'customField.reordered',
      ]),
    );
  });

  it('lists the subjects that take custom fields, to whoever may read their fields', async () => {
    // TestItem is the fixture every build has; Note may be removed
    // (pnpm feature:remove notes, CI's template-without-notes).
    const manager = await node.user([
      await role(['Access', 'manageCustomFields']),
    ]);
    const editor = await node.user(['editor']);
    const itemReader = await node.user([await role(['TestItem', 'read'])]);
    const outsider = await node.user([await role(['Ops', 'view'])]);
    const client = await node.client();
    type Entry = {
      subject: string;
      label: { singular: string; plural: string };
    };
    const subjects = (body: { items: Entry[] }) =>
      body.items.map((entry) => entry.subject);

    const all = await manager.agent
      .get('/v1/custom-fields/subjects')
      .expect(200);
    expect(subjects(all.body)).toContain('TestItem');
    for (const entry of all.body.items as Entry[]) {
      expect(entry.label.singular).toEqual(expect.any(String));
      expect(entry.label.singular).not.toBe('');
      expect(entry.label.plural).not.toBe('');
    }
    expect(subjects(all.body).sort((a, b) => a.localeCompare(b))).toEqual(
      subjects(
        (await editor.agent.get('/v1/custom-fields/subjects').expect(200)).body,
      ).sort((a, b) => a.localeCompare(b)),
    );

    // Only the subjects whose fields the caller may read (as GET /custom-fields).
    const items = await itemReader.agent
      .get('/v1/custom-fields/subjects')
      .expect(200);
    expect(subjects(items.body)).toEqual(['TestItem']);
    await itemReader.agent
      .get('/v1/custom-fields?subject=TestItem')
      .expect(200);
    for (const other of subjects(all.body).filter((s) => s !== 'TestItem')) {
      await itemReader.agent
        .get(`/v1/custom-fields?subject=${other}`)
        .expect(403);
    }

    await node
      .http()
      .get('/v1/custom-fields/subjects')
      .set('Authorization', client.auth)
      .expect(200);
    await outsider.agent.get('/v1/custom-fields/subjects').expect(403);
    await node.http().get('/v1/custom-fields/subjects').expect(401);
  });

  it('names the nested path of each error on a definition', async () => {
    const create = (body: Record<string, unknown>) =>
      node
        .admin()
        .post('/v1/custom-fields')
        .send({
          subject: 'TestItem',
          label: 'X',
          key: `k${randomUUID().slice(0, 6)}`,
          ...body,
        });
    const choice = (value: string) => ({ value, label: 'Label' });

    // Dotted, as everywhere (items.0.quantity): one error per input.
    const pattern = await create({
      type: 'text',
      validation: { pattern: '(' },
    }).expect(400);
    expect(pattern.body.code).toBe('validation_failed');
    expect(paths(pattern.body)).toEqual(['validation.pattern']);
    const lookahead = await create({
      type: 'text',
      validation: { pattern: 'a(?=b)' },
    }).expect(400);
    expect(paths(lookahead.body)).toEqual(['validation.pattern']);
    expect(lookahead.body.errors[0].message).toMatch(/lookahead|lookaround/i);

    const duplicate = await create({
      type: 'select',
      options: [
        choice('a'),
        choice('b'),
        choice('a'),
        choice('c'),
        choice('b'),
      ],
    }).expect(400);
    expect(paths(duplicate.body)).toEqual([
      'options.2.value',
      'options.4.value',
    ]);

    const bad = await create({
      type: 'select',
      options: [choice('a'), choice('b'), choice(' ')],
    }).expect(400);
    expect(paths(bad.body)).toEqual(['options.2.value']);
    const noLabel = await create({
      type: 'select',
      options: [{ value: 'a', label: '' }],
    }).expect(400);
    expect(paths(noLabel.body)).toEqual(['options.0.label']);
    const comma = await create({
      type: 'multiSelect',
      options: [choice('a'), choice('b,c')],
    }).expect(400);
    expect(paths(comma.body)).toEqual(['options.1.value']);

    // Several at once, each on its input.
    const many = await create({
      type: 'number',
      validation: { min: 5, max: 1, pattern: 'x' },
    }).expect(400);
    expect(paths(many.body).sort((a, b) => a.localeCompare(b))).toEqual([
      'validation.min',
      'validation.pattern',
    ]);

    // The same on a change, checked against the field as it would be saved.
    const text = await create({ type: 'text' }).expect(201);
    const select = await create({
      type: 'select',
      options: [choice('a'), choice('b')],
    }).expect(201);
    const patch = (id: string, body: Record<string, unknown>) =>
      node.admin().patch(`/v1/custom-fields/${id}`).send(body);
    expect(
      paths(
        (
          await patch(text.body.id, { validation: { pattern: '(' } }).expect(
            400,
          )
        ).body,
      ),
    ).toEqual(['validation.pattern']);
    expect(
      paths(
        (
          await patch(select.body.id, {
            options: [choice('a'), choice('b'), choice('a')],
          }).expect(400)
        ).body,
      ),
    ).toEqual(['options.2.value']);
    expect(
      paths(
        (
          await patch(select.body.id, {
            options: [choice('a'), choice('')],
          }).expect(400)
        ).body,
      ),
    ).toEqual(['options.1.value']);
  });

  it('counts the records that hold a value of each field, for those who manage them', async () => {
    const manager = await node.user([
      await role(['Access', 'manageCustomFields']),
    ]);
    const editor = await node.user(['editor']);
    await field({
      key: 'region',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'Americas' },
      ],
    });
    const note = await field({ key: 'note', type: 'text' });
    const counts = async (agent: request.Agent = manager.agent, query = '') =>
      Object.fromEntries(
        (
          (
            await agent
              .get(`/v1/custom-fields?subject=TestItem&include=counts${query}`)
              .expect(200)
          ).body.items as {
            key: string;
            valueCount: number;
            deletedValueCount: number;
          }[]
        ).map((item) => [item.key, [item.valueCount, item.deletedValueCount]]),
      );

    // Nothing is counted unless asked for; asking takes managing the fields.
    const plain = await manager.agent
      .get('/v1/custom-fields?subject=TestItem')
      .expect(200);
    expect(plain.body.items[0]).not.toHaveProperty('valueCount');
    expect(await counts()).toEqual({ region: [0, 0], note: [0, 0] });
    await editor.agent
      .get('/v1/custom-fields?subject=TestItem&include=counts')
      .expect(403);
    await manager.agent
      .get('/v1/custom-fields?subject=TestItem&include=other')
      .expect(400);

    const client = await node.client();
    const write = async (custom: Record<string, unknown>) =>
      (
        await node
          .writeItem(client.auth, { title: 'T', body: '', custom })
          .expect(201)
      ).body.id as string;
    await write({ region: 'eu', note: 'a' });
    await write({ region: 'us' });
    const trashed = await write({ region: 'eu' });
    await write({});
    expect(await counts()).toEqual({ region: [3, 0], note: [1, 0] });

    // The recycle bin is counted apart; removing a value drops the count.
    await node.admin().delete(`/v1/test-items/${trashed}`).expect(204);
    expect(await counts()).toEqual({ region: [2, 1], note: [1, 0] });
    const first = await write({ note: 'b' });
    await node
      .admin()
      .patch(`/v1/test-items/${first}`)
      .send({ custom: { note: null } })
      .expect(200);
    expect(await counts()).toEqual({ region: [2, 1], note: [1, 0] });

    // A deactivated field's values are kept, and counted (inactive fields listed).
    await node.admin().delete(`/v1/custom-fields/${note.id}`).expect(204);
    expect(await counts(manager.agent, '&includeInactive=true')).toEqual({
      region: [2, 1],
      note: [1, 0],
    });
    expect(await counts()).toEqual({ region: [2, 1] });

    // Another tenant's records are not seen, and it counts its own.
    const other = await node.otherTenant();
    const otherRegion = (
      await other.admin
        .post('/v1/custom-fields')
        .send({ subject: 'TestItem', key: 'region', label: 'R', type: 'text' })
        .expect(201)
    ).body as { id: string };
    const otherClient = await other.client();
    await node
      .writeItem(otherClient.auth, {
        title: 'O',
        body: '',
        custom: { region: 'x' },
      })
      .expect(201);
    const theirs = (
      await other.admin
        .get('/v1/custom-fields?subject=TestItem&include=counts')
        .expect(200)
    ).body.items as { id: string; valueCount: number }[];
    expect(theirs.map((item) => [item.id, item.valueCount])).toEqual([
      [otherRegion.id, 1],
    ]);
    expect((await counts()).region).toEqual([2, 1]);
  });

  it('checks every type of value, by field', async () => {
    await field({ key: 'title2', type: 'text', validation: { maxLength: 5 } });
    await field({ key: 'story', type: 'longText' });
    await field({
      key: 'amount',
      type: 'number',
      validation: { min: 0, max: 100 },
    });
    await field({ key: 'done', type: 'boolean' });
    await field({ key: 'due', type: 'date' });
    await field({
      key: 'region',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'Americas' },
      ],
    });
    await field({
      key: 'tags',
      type: 'multiSelect',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      validation: { max: 2 },
    });
    await field({ key: 'contact', type: 'email' });
    await field({ key: 'site', type: 'url' });
    await field({
      key: 'code',
      type: 'text',
      validation: { pattern: '[A-Z]{3}' },
    });
    const client = await node.client();

    const valid = {
      title2: 'short',
      story: 'x'.repeat(5_000),
      amount: 42.5,
      done: true,
      due: '2026-12-31',
      region: 'eu',
      tags: ['a', 'b'],
      contact: 'sam@example.com',
      site: 'https://example.com/x',
      code: 'ABC',
    };
    const created = await node
      .writeItem(client.auth, {
        title: 'Typed',
        body: '',
        custom: valid,
      })
      .expect(201);
    expect(created.body.custom).toEqual(valid);
    const read = await node
      .http()
      .get(`/v1/test-items/${created.body.id}`)
      .set('Authorization', client.auth)
      .expect(200);
    expect(read.body.custom).toEqual(valid);

    const wrong: [string, unknown][] = [
      ['title2', 'too long'],
      ['title2', 5],
      ['story', 'x'.repeat(10_001)],
      ['amount', '42'],
      ['amount', 101],
      ['done', 'yes'],
      ['due', '31/12/2026'],
      ['region', 'asia'],
      ['tags', ['a', 'c']],
      ['tags', ['a', 'a']],
      ['tags', 'a'],
      ['contact', 'not-an-email'],
      ['site', 'javascript:alert(1)'],
      ['code', 'abc'],
      ['nope', 'x'],
    ];
    for (const [key, value] of wrong) {
      const refused = await node
        .writeItem(client.auth, {
          title: 'Bad',
          body: '',
          custom: { [key]: value },
        })
        .expect(400);
      expect(refused.body.code).toBe('validation_failed');
      expect(
        paths(refused.body).some((path) => path.startsWith(`custom.${key}`)),
      ).toBe(true);
    }
  });

  it('enforces required fields on create, fills defaults, merges updates and audits each key', async () => {
    await field({ key: 'code', type: 'text', required: true });
    await field({
      key: 'priority',
      type: 'number',
      required: true,
      default: 3,
    });
    await field({ key: 'region', type: 'text' });
    const editor = await node.user(['editor']);

    const missing = await node
      .writeItem(editor.agent, {
        title: 'No code',
        body: '',
      })
      .expect(400);
    expect(paths(missing.body)).toEqual(['custom.code']);

    const created = await node
      .writeItem(editor.agent, {
        title: 'Coded',
        body: '',
        custom: { code: 'A1', region: 'north' },
      })
      .expect(201);
    expect(created.body.custom).toEqual({
      code: 'A1',
      priority: 3,
      region: 'north',
    });
    const id = created.body.id as string;

    // Only the keys sent change; null removes one; a required one can't go.
    const merged = await editor.agent
      .patch(`/v1/test-items/${id}`)
      .send({ custom: { region: 'south' } })
      .expect(200);
    expect(merged.body.custom).toEqual({
      code: 'A1',
      priority: 3,
      region: 'south',
    });
    const removed = await editor.agent
      .patch(`/v1/test-items/${id}`)
      .send({ title: 'Renamed', custom: { region: null } })
      .expect(200);
    expect(removed.body.custom).toEqual({ code: 'A1', priority: 3 });
    expect(removed.body.title).toBe('Renamed');
    const required = await editor.agent
      .patch(`/v1/test-items/${id}`)
      .send({ custom: { code: null } })
      .expect(400);
    expect(paths(required.body)).toEqual(['custom.code']);
    await editor.agent
      .patch(`/v1/test-items/${id}`)
      .send({ custom: { nope: 1 } })
      .expect(400);

    // The audit holds each key that changed, as for any other field.
    const audit = await node
      .admin()
      .get(`/v1/access/audit?action=testItem.updated&targetId=${id}`)
      .expect(200);
    const changes = audit.body.items.map(
      (entry: { details: { changes: Record<string, unknown> } }) =>
        entry.details.changes,
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        { 'custom.region': { from: 'north', to: 'south' } },
        {
          title: { from: 'Coded', to: 'Renamed' },
          'custom.region': { from: 'south', to: null },
        },
      ]),
    );
  });

  it('treats custom values as one restrictable field', async () => {
    await field({ key: 'region', type: 'text' });
    const client = await node.client();
    const item = await node
      .writeItem(client.auth, {
        title: 'Hi',
        body: 'x',
        custom: { region: 'eu' },
      })
      .expect(201);
    // May read test items, but not their custom fields.
    const reader = await node.user([
      await role(
        ['TestItem', 'read', ['body']],
        ['TestItem', 'create', ['body']],
      ),
    ]);
    const read = await reader.agent
      .get(`/v1/test-items/${item.body.id}`)
      .expect(200);
    expect(read.body.custom).toBeUndefined();
    expect(read.body.body).toBe('x');
    const refused = await node
      .writeItem(reader.agent, {
        title: 'Mine',
        body: '',
        custom: { region: 'eu' },
      })
      .expect(403);
    expect(refused.body.fields).toEqual(['custom']);
  });

  it('keeps the values of a deactivated field, and refuses type changes that would break values', async () => {
    const region = await field({ key: 'region', type: 'text' });
    const unused = await field({ key: 'unused', type: 'text' });
    const size = await field({
      key: 'size',
      type: 'select',
      options: [
        { value: 's', label: 'S' },
        { value: 'l', label: 'L' },
      ],
    });
    const client = await node.client();
    const item = await node
      .writeItem(client.auth, {
        title: 'Kept',
        body: '',
        custom: { region: 'eu', size: 's' },
      })
      .expect(201);

    // Type changes: refused while values exist, unless every value stays valid.
    const refused = await node
      .admin()
      .patch(`/v1/custom-fields/${region.id}`)
      .send({ type: 'number' })
      .expect(409);
    expect(refused.body.code).toBe('custom_field_in_use');
    await node
      .admin()
      .patch(`/v1/custom-fields/${region.id}`)
      .send({ type: 'longText' })
      .expect(200);
    await node
      .admin()
      .patch(`/v1/custom-fields/${unused.id}`)
      .send({ type: 'number' })
      .expect(200);
    // A choice records hold can't be removed; an unused one can.
    await node
      .admin()
      .patch(`/v1/custom-fields/${size.id}`)
      .send({ options: [{ value: 'l', label: 'L' }] })
      .expect(409);
    await node
      .admin()
      .patch(`/v1/custom-fields/${size.id}`)
      .send({ options: [{ value: 's', label: 'Small' }] })
      .expect(200);

    // Deactivated: refused on writes, ignored when required, but values stay.
    await node
      .admin()
      .patch(`/v1/custom-fields/${region.id}`)
      .send({ required: true })
      .expect(200);
    await node.admin().delete(`/v1/custom-fields/${region.id}`).expect(204);
    await node
      .writeItem(client.auth, { title: 'Without', body: '' })
      .expect(201);
    const unknown = await node
      .writeItem(client.auth, {
        title: 'With',
        body: '',
        custom: { region: 'us' },
      })
      .expect(400);
    expect(paths(unknown.body)).toEqual(['custom.region']);
    const kept = await node
      .http()
      .get(`/v1/test-items/${item.body.id}`)
      .set('Authorization', client.auth)
      .expect(200);
    // Hidden while the field is inactive, still stored.
    expect(kept.body.custom).toEqual({ size: 's' });
    const [stored] = await node.inTenant(() =>
      node.app
        .get(TestItemsService)
        .query((db) =>
          db
            .select({ custom: testItems.custom })
            .from(testItems)
            .where(eq(testItems.id, item.body.id)),
        ),
    );
    expect(stored.custom).toEqual({ region: 'eu', size: 's' });
    // Another field can't take its key.
    await node
      .admin()
      .post('/v1/custom-fields')
      .send({ subject: 'TestItem', key: 'region', label: 'R', type: 'number' })
      .expect(409);
    // Brought back: accepted again.
    await node
      .admin()
      .patch(`/v1/custom-fields/${region.id}`)
      .send({ active: true, required: false })
      .expect(200);
    await node
      .writeItem(client.auth, {
        title: 'With',
        body: '',
        custom: { region: 'us' },
      })
      .expect(201);
  });

  it('exports custom fields as columns and imports them with the same checks', async () => {
    await field({ key: 'amount', type: 'number' });
    await field({ key: 'done', type: 'boolean' });
    await field({
      key: 'tags',
      type: 'multiSelect',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const client = await node.client();
    await node
      .writeItem(client.auth, {
        title: 'Exported',
        body: 'x',
        custom: { amount: 12.5, done: true, tags: ['a', 'b'] },
      })
      .expect(201);

    async function finished(id: string, auth = client.auth) {
      for (let tries = 0; tries < 100; tries++) {
        const status = await node
          .http()
          .get(`/v1/data/transfers/${id}`)
          .set('Authorization', auth)
          .expect(200);
        if (['completed', 'failed'].includes(status.body.status)) {
          return status.body;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('The transfer never finished');
    }

    const catalog = await node
      .http()
      .get('/v1/data')
      .set('Authorization', client.auth)
      .expect(200);
    expect(
      catalog.body.exports.find(
        (e: { name: string }) => e.name === 'test-items',
      ).columns,
    ).toEqual(expect.arrayContaining(['custom.amount', 'custom.tags']));

    const started = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', client.auth)
      .send({ name: 'test-items', format: 'csv' })
      .expect(202);
    const done = await finished(started.body.id);
    expect(done.status).toBe('completed');
    const csv = (await node.http().get(local(done.result.url)).expect(200))
      .text;
    const [header, line] = csv.replace(/^﻿/, '').trim().split('\n');
    expect(header).toBe(
      // A client has no zone of its own: APP_TIMEZONE (UTC here).
      'id,number,title,body,publishedAt (UTC),code,tags,owner,createdAt (UTC),custom.amount,custom.done,custom.tags',
    );
    expect(line).toContain('12.5,true,"[""a"",""b""]"');

    // The file back in, as another client: the values arrive typed.
    const other = await node.client();
    const file = `title,body,custom.amount,custom.done,custom.tags\nExported,x,12.5,true,"[""a"",""b""]"\nSecond,y,7,no,a\nBad,z,lots,maybe,c\n`;
    const imported = await node
      .http()
      .post('/v1/data/imports')
      .set('Authorization', other.auth)
      .field('name', 'test-items')
      .attach('file', Buffer.from(file), {
        filename: 'test-items.csv',
        contentType: 'text/csv',
      })
      .expect(202);
    const result = await finished(imported.body.id, other.auth);
    expect(result.result).toMatchObject({ rows: 3, imported: 2, failed: 1 });
    const report = await node
      .http()
      .get(local(result.result.errorsUrl))
      .expect(200);
    expect(report.text).toContain('3,custom.amount,');
    expect(report.text).toContain('3,custom.done,');
    expect(report.text).toContain('3,custom.tags.0,');
    const items = (
      await node.http().get('/v1/test-items').set('Authorization', other.auth)
    ).body.items as { title: string; custom: Record<string, unknown> }[];
    expect(
      Object.fromEntries(items.map((item) => [item.title, item.custom])),
    ).toEqual({
      Exported: { amount: 12.5, done: true, tags: ['a', 'b'] },
      Second: { amount: 7, done: false, tags: ['a'] },
    });

    // A column of a field that doesn't exist fails the import up front, by
    // name: no row could pass it.
    const unknown = await node
      .http()
      .post('/v1/data/imports')
      .set('Authorization', other.auth)
      .field('name', 'test-items')
      .attach('file', Buffer.from('title,body,custom.nope\nA,b,c\n'), {
        filename: 'test-items.csv',
        contentType: 'text/csv',
      })
      .expect(202);
    const refused = await finished(unknown.body.id, other.auth);
    expect(refused).toMatchObject({
      status: 'failed',
      error: 'Unknown columns: custom.nope. Check the template.',
    });
  });

  it('imports as POST does: defaults without the custom permission, JSON with custom nested, exported text back as written', async () => {
    await field({ key: 'region', type: 'text', default: 'eu' });
    await field({ key: 'phone', type: 'text' });
    await field({
      key: 'area',
      type: 'select',
      options: [
        { value: 'eu', label: 'Europe' },
        { value: 'us', label: 'United States' },
      ],
    });
    /** Uploads `file` as a test items import and waits for its result. */
    async function imported(
      auth: string | request.Agent,
      file: string,
      filename: string,
    ) {
      const started = await (
        typeof auth === 'string'
          ? node.http().post('/v1/data/imports').set('Authorization', auth)
          : auth.post('/v1/data/imports')
      )
        .field('name', 'test-items')
        .attach('file', Buffer.from(file), {
          filename,
          contentType: filename.endsWith('.json')
            ? 'application/json'
            : 'text/csv',
        })
        .expect(202);
      return finished(started.body.id, auth);
    }

    // May create test items, but not set their custom fields: the template has
    // no custom column, and a file without one imports (the service fills
    // the default, as on POST); a file that sets one is refused.
    const limited = await node.user([
      await role(
        ['TestItem', 'read', ['body']],
        ['TestItem', 'create', ['body']],
      ),
    ]);
    const template = await limited.agent
      .get('/v1/data/imports/test-items/template')
      .expect(200);
    expect(template.text.replace(/^\uFEFF/, '').split('\n')[0]).toBe(
      'title,body,publishedAt (UTC),code',
    );
    const plain = await imported(
      limited.agent,
      'title,body\nDefaulted,x\n',
      'test-items.csv',
    );
    expect(plain.result).toMatchObject({ imported: 1, failed: 0 });
    const defaulted = await node
      .admin()
      .get('/v1/test-items?title.contains=Defaulted')
      .expect(200);
    expect(defaulted.body.items[0].custom).toEqual({ region: 'eu' });
    const refused = await imported(
      limited.agent,
      'title,body,custom.region\nSet,x,us\n',
      'test-items.csv',
    );
    expect(refused.result).toMatchObject({ imported: 0, failed: 1 });
    const report = await node
      .http()
      .get(local(refused.result.errorsUrl))
      .expect(200);
    expect(report.text).toContain('1,custom,You may not set this field.');

    // The template's choices are the options' labels, and an import takes
    // a label (whatever its case) or a value.
    const client = await node.client();
    const catalog = await node
      .http()
      .get('/v1/data')
      .set('Authorization', client.auth)
      .expect(200);
    expect(
      catalog.body.imports
        .find((i: { name: string }) => i.name === 'test-items')
        .columns.find((c: { name: string }) => c.name === 'custom.area'),
    ).toMatchObject({ type: 'text', options: ['Europe', 'United States'] });

    // A JSON file may nest the values as a POST body does; both ways at
    // once is refused by name.
    const json = await imported(
      client.auth,
      JSON.stringify([
        {
          title: 'Nested',
          body: '',
          custom: { region: 'us', phone: '+63 912', area: 'united states' },
        },
        { title: 'Flat', body: '', 'custom.region': 'us', 'custom.area': 'eu' },
        {
          title: 'Twice',
          body: '',
          custom: { region: 'us' },
          'custom.region': 'eu',
        },
      ]),
      'test-items.json',
    );
    expect(json.result).toMatchObject({ rows: 3, imported: 2, failed: 1 });
    const twice = await node
      .http()
      .get(local(json.result.errorsUrl))
      .expect(200);
    expect(twice.text).toContain('3,custom.region,Given twice');
    const stored = (
      await node.http().get('/v1/test-items').set('Authorization', client.auth)
    ).body.items as { title: string; custom: Record<string, unknown> }[];
    expect(
      Object.fromEntries(stored.map((item) => [item.title, item.custom])),
    ).toEqual({
      Nested: { region: 'us', phone: '+63 912', area: 'us' },
      Flat: { region: 'us', area: 'eu' },
    });

    // Text a spreadsheet would run as a formula is quoted in the export
    // (`'+63 912`), and comes back as written when the file is imported.
    const started = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', client.auth)
      .send({
        name: 'test-items',
        format: 'csv',
        filters: { 'title.contains': 'Nested' },
      })
      .expect(202);
    const done = await finished(started.body.id, client.auth);
    const csv = (await node.http().get(local(done.result.url)).expect(200))
      .text;
    expect(csv).toContain("'+63 912");
    const other = await node.client();
    const back = await imported(other.auth, csv, 'test-items.csv');
    expect(back.result).toMatchObject({ rows: 1, imported: 1, failed: 0 });
    const copy = (
      await node.http().get('/v1/test-items').set('Authorization', other.auth)
    ).body.items as { custom: Record<string, unknown> }[];
    expect(copy.map((item) => item.custom)).toEqual([
      { region: 'us', phone: '+63 912', area: 'us' },
    ]);
  });

  it('exports date fields as Excel date cells, read back as days', async () => {
    await field({ key: 'due', type: 'date' });
    const client = await node.client();
    await node
      .writeItem(client.auth, {
        title: 'Dated',
        body: '',
        custom: { due: '2026-01-05' },
      })
      .expect(201);
    const started = await node
      .http()
      .post('/v1/data/exports')
      .set('Authorization', client.auth)
      .send({ name: 'test-items', format: 'xlsx' })
      .expect(202);
    const done = await finished(started.body.id, client.auth);
    const file = (
      await node
        .http()
        .get(local(done.result.url))
        .responseType('blob')
        .expect(200)
    ).body as Buffer;
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    const column = (sheet.getRow(1).values as unknown[]).indexOf('custom.due');
    expect(column).toBeGreaterThan(0);
    const cell = sheet.getRow(2).getCell(column);
    expect(cell.value).toEqual(new Date('2026-01-05T00:00:00Z'));
    expect(cell.numFmt).toBe('yyyy-mm-dd');

    // The file back in: the date cell is the day again.
    const other = await node.client();
    const back = await node
      .http()
      .post('/v1/data/imports')
      .set('Authorization', other.auth)
      .field('name', 'test-items')
      .attach('file', file, { filename: 'test-items.xlsx' })
      .expect(202);
    expect((await finished(back.body.id, other.auth)).result).toMatchObject({
      imported: 1,
      failed: 0,
    });
    const copy = (
      await node.http().get('/v1/test-items').set('Authorization', other.auth)
    ).body.items as { custom: Record<string, unknown> }[];
    expect(copy[0]!.custom).toEqual({ due: '2026-01-05' });
  });

  describe('in lists', () => {
    /** Test items as one API client, each with these custom values. */
    async function itemsWith(values: Record<string, unknown>[]) {
      const { auth } = await node.client();
      for (const [i, custom] of values.entries()) {
        await node
          .writeItem(auth, {
            title: `Item ${i}`,
            body: 'x',
            custom,
          })
          .expect(201);
      }
      return Object.assign(
        (query: string) =>
          node.http().get(`/v1/test-items${query}`).set('Authorization', auth),
        { auth },
      );
    }
    const titles = (body: { items: { title: string }[] }) =>
      body.items.map((item) => item.title);

    it('filters by equality, any-of and presence with the same results as before the GIN rewrite', async () => {
      await field({ key: 'note', type: 'text', filterable: true });
      await field({
        key: 'region',
        type: 'select',
        options: ['eu', 'us'].map((value) => ({ value, label: value })),
        filterable: true,
      });
      await field({ key: 'amount', type: 'number', filterable: true });
      await field({ key: 'done', type: 'boolean', filterable: true });
      await field({ key: 'due', type: 'date', filterable: true });
      await field({
        key: 'tags',
        type: 'multiSelect',
        options: ['a', 'b', 'c'].map((value) => ({ value, label: value })),
        filterable: true,
      });
      const list = await itemsWith([
        {
          note: 'x',
          region: 'eu',
          amount: 5,
          done: false,
          due: '2026-01-05',
          tags: ['a', 'b'],
        },
        { note: 'y', region: 'us', amount: 2.5, done: true, tags: ['c'] },
        {}, // no key at all
        { region: 'eu', amount: 7 }, // its region is removed below
      ]);
      const removed = (await list('').expect(200)).body.items.find(
        (item: { title: string }) => item.title === 'Item 3',
      ) as { id: string };
      await node
        .http()
        .patch(`/v1/test-items/${removed.id}`)
        .set('Authorization', list.auth)
        .send({ custom: { region: null } })
        .expect(200);
      const found = async (query: string) =>
        titles((await list(query).expect(200)).body).sort((a, b) =>
          a.localeCompare(b),
        );

      expect(await found('?custom.note=x')).toEqual(['Item 0']);
      expect(await found('?custom.note.in=x,y')).toEqual(['Item 0', 'Item 1']);
      expect(await found('?custom.region=eu')).toEqual(['Item 0']);
      expect(await found('?custom.amount=5')).toEqual(['Item 0']);
      expect(await found('?custom.amount=2.5')).toEqual(['Item 1']);
      expect(await found('?custom.amount.in=2.5,5')).toEqual([
        'Item 0',
        'Item 1',
      ]);
      expect(await found('?custom.done=false')).toEqual(['Item 0']);
      expect(await found('?custom.done=true')).toEqual(['Item 1']);
      expect(await found('?custom.due=2026-01-05')).toEqual(['Item 0']);
      expect(await found('?custom.tags.in=b,c')).toEqual(['Item 0', 'Item 1']);
      expect(await found('?custom.tags.in=zz')).toEqual([]);
      expect(await found('?custom.region.isNull=false')).toEqual([
        'Item 0',
        'Item 1',
      ]);
      expect(await found('?custom.region.isNull=true')).toEqual([
        'Item 2',
        'Item 3',
      ]);
      const filter = encodeURIComponent(
        JSON.stringify({
          or: [
            { field: 'custom.tags', op: 'in', value: ['c'] },
            { field: 'custom.amount', op: 'eq', value: 5 },
          ],
        }),
      );
      expect(await found(`?filter=${filter}`)).toEqual(['Item 0', 'Item 1']);
    });

    it('filters, sorts and selects custom fields like declared ones', async () => {
      await field({
        key: 'region',
        type: 'select',
        options: [
          { value: 'eu', label: 'Europe' },
          { value: 'us', label: 'Americas' },
        ],
        filterable: true,
        sortable: true,
      });
      await field({
        key: 'amount',
        type: 'number',
        filterable: true,
        sortable: true,
      });
      await field({
        key: 'due',
        type: 'date',
        filterable: true,
        sortable: true,
      });
      await field({
        key: 'tags',
        type: 'multiSelect',
        options: ['a', 'b', 'c'].map((value) => ({ value, label: value })),
        filterable: true,
      });
      await field({ key: 'secret', type: 'text' }); // neither filterable nor sortable
      const list = await itemsWith([
        { region: 'eu', amount: 5, due: '2026-03-01', tags: ['a'] },
        { region: 'us', amount: 50, due: '2026-01-15', tags: ['b', 'c'] },
        { region: 'eu', amount: 20, tags: ['c'] },
        { amount: 1 },
      ]);

      expect(
        titles((await list('?custom.region=eu').expect(200)).body).sort(
          (a, b) => a.localeCompare(b),
        ),
      ).toEqual(['Item 0', 'Item 2']);
      expect(
        titles((await list('?custom.amount.gte=10').expect(200)).body).sort(
          (a, b) => a.localeCompare(b),
        ),
      ).toEqual(['Item 1', 'Item 2']);
      expect(
        titles((await list('?custom.due.lt=2026-02-01').expect(200)).body),
      ).toEqual(['Item 1']);
      // multiSelect: holds any of.
      expect(
        titles((await list('?custom.tags.in=a,b').expect(200)).body).sort(
          (a, b) => a.localeCompare(b),
        ),
      ).toEqual(['Item 0', 'Item 1']);
      const filter = encodeURIComponent(
        JSON.stringify({
          or: [
            { field: 'custom.region', op: 'eq', value: 'us' },
            { field: 'custom.amount', op: 'lt', value: 2 },
          ],
        }),
      );
      expect(
        titles((await list(`?filter=${filter}`).expect(200)).body).sort(
          (a, b) => a.localeCompare(b),
        ),
      ).toEqual(['Item 1', 'Item 3']);

      // Sorted by a number, paged two at a time: every item once, in order (no value last).
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: {
          body: { items: { title: string }[]; nextCursor: string | null };
        } = await list(
          `?sort=custom.amount&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200);
        // The sort value selected for the cursor never reaches the client.
        for (const item of res.body.items) {
          expect(item).not.toHaveProperty(['custom.amount']);
        }
        seen.push(...titles(res.body));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['Item 3', 'Item 0', 'Item 2', 'Item 1']);
      // Descending: no value counts as the largest, so it comes first (ties: newest first).
      expect(
        titles((await list('?sort=-custom.due').expect(200)).body),
      ).toEqual(['Item 3', 'Item 2', 'Item 0', 'Item 1']);

      // fields: inside custom too.
      const picked = await list(
        '?fields=title,custom.region&custom.region=us',
      ).expect(200);
      expect(picked.body.items).toEqual([
        { id: expect.any(String), title: 'Item 1', custom: { region: 'us' } },
      ]);

      // Not filterable, not sortable, unknown: 400 naming it.
      await list('?custom.secret=x').expect(400);
      await list('?sort=custom.secret').expect(400);
      await list('?sort=custom.tags').expect(400);
      await list('?custom.nope=1').expect(400);
      await list('?custom.region=mars').expect(400);
    });

    it('applies a new field at once, and hides a deactivated one', async () => {
      const list = await itemsWith([{}]);
      await list('?custom.color=red').expect(400);
      const color = await field({
        key: 'color',
        type: 'text',
        filterable: true,
      });
      await list('?custom.color=red').expect(200);
      const { auth } = await node.client();
      const created = await node
        .writeItem(auth, {
          title: 'Red',
          body: 'x',
          custom: { color: 'red' },
        })
        .expect(201);
      expect(created.body.custom).toEqual({ color: 'red' });

      await node.admin().delete(`/v1/custom-fields/${color.id}`).expect(204);
      const shown = await node
        .http()
        .get(`/v1/test-items/${created.body.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(shown.body.custom).toEqual({}); // kept, not shown
      await list('?custom.color=red').expect(400);
      await node
        .admin()
        .patch(`/v1/custom-fields/${color.id}`)
        .send({ active: true })
        .expect(200);
      const back = await node
        .http()
        .get(`/v1/test-items/${created.body.id}`)
        .set('Authorization', auth)
        .expect(200);
      expect(back.body.custom).toEqual({ color: 'red' });
    });

    it('runs patterns on RE2: linear time on any value, no lookaround or backreferences', async () => {
      // What RE2 can't run (it would need backtracking) is refused when
      // saved, naming the pattern and the reason.
      for (const [pattern, reason] of [
        ['(?=a)b', /^Lookahead and lookbehind/],
        ['(?<!a)b', /^Lookahead and lookbehind/],
        ['(x)\\1', /^Backreferences/],
        ['(?<n>x)\\k<n>', /^Backreferences/],
        ['a{1001}', /^A repetition count/],
        ['[', /^Not a valid regular expression/],
      ] as const) {
        const refused = await node
          .admin()
          .post('/v1/custom-fields')
          .send({
            subject: 'TestItem',
            key: `p${randomUUID().slice(0, 6).replace(/-/g, '')}`
              .toLowerCase()
              .replace(/[^a-z0-9_]/g, 'x'),
            label: 'P',
            type: 'text',
            validation: { pattern },
          })
          .expect(400);
        expect(refused.body.code).toBe('validation_failed');
        expect(refused.body.errors, pattern).toEqual([
          {
            path: 'validation.pattern',
            message: expect.stringMatching(reason),
          },
        ]);
      }
      // Patterns that make a backtracking engine take exponential time on a
      // crafted value save, since RE2 runs them in linear time: the crafted
      // value is checked (and refused) in the request, quickly.
      await field({
        key: 'evil',
        type: 'longText',
        validation: { pattern: '(a|aa)+$' },
      });
      await field({
        key: 'slow',
        type: 'longText',
        validation: { pattern: '.*.*.*.*x' },
      });
      const { auth } = await node.client();
      const started = performance.now();
      const refused = await node
        .writeItem(auth, {
          title: 'Crafted',
          body: 'x',
          // 10,000 characters: longText's limit, so the pattern is the only issue.
          custom: { evil: `${'a'.repeat(9_999)}!`, slow: 'a'.repeat(10_000) },
        })
        .expect(400);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(paths(refused.body)).toEqual(['custom.evil', 'custom.slow']);
      await node
        .writeItem(auth, {
          title: 'Fine',
          body: 'x',
          custom: { evil: 'aaa', slow: 'aax' },
        })
        .expect(201);
      await field({
        key: 'code',
        type: 'text',
        validation: { pattern: '[A-Z]{3}-\\d{4}' },
      });
    });
  });
});
