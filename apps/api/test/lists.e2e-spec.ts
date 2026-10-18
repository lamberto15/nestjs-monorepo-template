import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { bootApp, type TestApp } from './support.js';

type Field = {
  name: string;
  type: string;
  options?: string[];
  operators: string[];
  sortable: boolean;
  custom: boolean;
  label?: string;
  ref?: string;
};

/** GET /v1/lists/{subject}: a list described (docs/api-conventions.md, "List metadata"). */
describe('list metadata (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A role of these permissions (no conditions), by id. */
  async function role(
    by: request.Agent,
    ...permissions: [string, string, string[]?][]
  ) {
    const created = await by
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

  const names = (fields: Field[]) => fields.map((field) => field.name);

  it("describes a record's list from its declaration: filters, operators, sorts, search, limits", async () => {
    const editor = await node.user(['editor']);
    const { body } = await editor.agent.get('/v1/lists/TestItem').expect(200);

    expect(body).toMatchObject({
      subject: 'TestItem',
      search: true,
      defaultSort: '-createdAt',
      // Editors may restore their own (the recycle bin).
      recycleBin: true,
      limits: {
        defaultLimit: 50,
        maxLimit: 100,
        maxOffset: 10_000,
        countCap: 10_000,
        maxSort: 3,
        maxConditions: 30,
        maxDepth: 3,
        maxValues: 50,
      },
      // From its declaration (test-item.record.ts): pdf off without
      // Gotenberg, events on with WEBHOOKS, approvals from its declared action.
      capabilities: {
        tags: true,
        comments: true,
        attachments: true,
        revisions: true,
        pdf: false,
        bulk: true,
        watch: true,
        search: true,
        transfer: true,
        custom: true,
        events: true,
        numbered: true,
        approvals: true,
      },
      // What the upload route enforces (ATTACHMENT_MAX_MB, ATTACHMENT_ALLOWED_TYPES).
      attachmentLimits: {
        maxBytes: 25 * 1024 * 1024,
        maxMb: 25,
        types: expect.arrayContaining(['image/png', 'application/pdf']),
      },
    });
    const fields = body.fields as Field[];
    expect(fields.find((field) => field.name === 'title')).toEqual({
      name: 'title',
      type: 'string',
      operators: ['eq', 'contains', 'startsWith'],
      sortable: true,
      custom: false,
    });
    expect(fields.find((field) => field.name === 'body')).toMatchObject({
      type: 'string',
      operators: ['contains', 'isNull'],
      sortable: false,
    });
    expect(fields.find((field) => field.name === 'createdAt')).toMatchObject({
      type: 'datetime',
      operators: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: true,
    });
    expect(names(fields)).toEqual(
      expect.arrayContaining([
        'number',
        'tag',
        'ownerId',
        'teamId',
        'updatedAt',
      ]),
    );
    // The fields whose values are ids of something say of what (a generated record's declaration); the record's own fields don't.
    const refs = Object.fromEntries(
      fields
        .filter((field) => field.ref)
        .map((field) => [field.name, field.ref]),
    );
    expect(refs).toEqual({ tag: 'tag', ownerId: 'principal', teamId: 'team' });
    // `q` and `rank` are `search`, not fields.
    expect(names(fields)).not.toContain('q');
    expect(names(fields)).not.toContain('rank');
    expect(body.select).toEqual(expect.arrayContaining(['title', 'body']));

    // What it says is what the list route takes.
    for (const field of fields.filter((f) =>
      f.operators.includes('contains'),
    )) {
      await editor.agent
        .get(`/v1/test-items?${field.name}.contains=x`)
        .expect(200);
    }
    await editor.agent.get('/v1/test-items?sort=-createdAt,title').expect(200);
  });

  it('leaves out a field the caller may not read, and the recycle bin they may not list', async () => {
    // Of the restrictable fields (body, custom), only custom.
    const reader = await node.user([
      await role(node.admin(), ['TestItem', 'read', ['custom']]),
    ]);
    const { body } = await reader.agent.get('/v1/lists/TestItem').expect(200);
    expect(names(body.fields)).not.toContain('body');
    expect(body.select).not.toContain('body');
    expect(body.select).toContain('custom');
    // Fields no permission restricts are always there.
    expect(names(body.fields)).toContain('title');
    expect(body.recycleBin).toBe(false);
  });

  it("merges the tenant's active custom fields, and never another tenant's", async () => {
    await node
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
        filterable: true,
        sortable: true,
      })
      .expect(201);
    const other = await node.otherTenant();
    await other.admin
      .post('/v1/custom-fields')
      .send({
        subject: 'TestItem',
        key: 'secret',
        label: 'Secret',
        type: 'text',
        filterable: true,
      })
      .expect(201);

    const editor = await node.user(['editor']);
    const mine = await editor.agent.get('/v1/lists/TestItem').expect(200);
    expect(
      (mine.body.fields as Field[]).find((f) => f.name === 'custom.region'),
    ).toEqual({
      name: 'custom.region',
      type: 'enum',
      options: ['eu', 'us'],
      operators: ['eq', 'ne', 'in', 'notIn', 'isNull'],
      sortable: true,
      custom: true,
      label: 'Region',
    });
    expect(mine.body.select).toContain('custom.region');
    expect(JSON.stringify(mine.body)).not.toContain('secret');
    // The list route takes what the description says.
    await editor.agent
      .get('/v1/test-items?custom.region.in=eu&sort=custom.region')
      .expect(200);

    const theirs = await other.admin.get('/v1/lists/TestItem').expect(200);
    expect(names(theirs.body.fields)).toContain('custom.secret');
    expect(JSON.stringify(theirs.body)).not.toContain('region');

    // Without the `custom` field-level permission: no custom field at all.
    const reader = await node.user([
      await role(node.admin(), ['TestItem', 'read', ['body']]),
    ]);
    const hidden = await reader.agent.get('/v1/lists/TestItem').expect(200);
    expect((hidden.body.fields as Field[]).some((f) => f.custom)).toBe(false);
    expect(
      (hidden.body.select as string[]).filter((n) => n.startsWith('custom')),
    ).toEqual([]);
  });

  it('answers API clients as it answers users', async () => {
    const client = await node.client();
    const { body } = await node
      .http()
      .get('/v1/lists/TestItem')
      .set('Authorization', client.auth)
      .expect(200);
    expect(names(body.fields)).toContain('title');
  });

  it('refuses the unauthenticated (401), those who may not read the subject (403), unknown subjects (404)', async () => {
    const unauthenticated = await node
      .http()
      .get('/v1/lists/TestItem')
      .expect(401);
    expect(unauthenticated.body.status).toBe(401);

    const outsider = await node.user([
      await role(node.admin(), ['Ops', 'view']),
    ]);
    const forbidden = await outsider.agent
      .get('/v1/lists/TestItem')
      .expect(403);
    expect(forbidden.body.code).toBe('forbidden');

    const unknown = await outsider.agent.get('/v1/lists/Nothing').expect(404);
    expect(unknown.body.code).toBe('not_found');
    await node.admin().get('/v1/lists/Nothing').expect(404);
  });
});
