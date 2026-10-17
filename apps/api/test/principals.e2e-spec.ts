import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { listSchema, pageSchema } from '../src/core/http/pagination.js';
import {
  auditEntrySchema,
  catalogSchema,
  principalSchema,
  roleViewSchema,
  userViewSchema,
} from '../src/iam/access/access.schemas.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The access API's read routes answer what their OpenAPI schemas say (the
 * typed client's types), and GET /v1/access/principals: the tenant's users
 * and API clients, searched, for the pickers of settings' overrides.
 */
describe('access responses and principals (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A member of the seeded tenant with this name, who accepted the invitation. */
  async function member(
    name: string,
    email = `${randomUUID().slice(0, 8)}@example.com`,
  ) {
    const token = await node.invite(node.admin(), { email, name });
    await node.acceptAsNew(token);
    return email;
  }

  type Principal = z.infer<typeof principalSchema>;
  const search = async (
    query: Record<string, string>,
    agent = node.admin(),
  ) => {
    const page = await agent
      .get('/v1/access/principals')
      .query(query)
      .expect(200);
    return pageSchema(principalSchema.strict()).parse(page.body);
  };
  const labels = (items: Principal[]) => items.map((item) => item.label).sort();

  it('answers the users, roles, catalog and audit log in the shape their schemas declare', async () => {
    await member('Typed Person');
    const admin = node.admin();
    const users = await admin.get('/v1/access/users').expect(200);
    const parsed = pageSchema(userViewSchema.strict()).parse(users.body);
    expect(parsed.items.map((user) => user.name)).toContain('Typed Person');
    // `fields=` narrows the items to what was asked (and id).
    const picked = await admin.get('/v1/access/users?fields=email').expect(200);
    expect(Object.keys(picked.body.items[0]).sort()).toEqual(['email', 'id']);

    const roles = await admin.get('/v1/access/roles').expect(200);
    listSchema(roleViewSchema.strict()).parse(roles.body);
    const created = await admin
      .post('/v1/access/roles')
      .send({ name: `role-${randomUUID().slice(0, 8)}`, permissions: [] })
      .expect(201);
    expect(Object.keys(created.body)).toEqual(['id']);

    const catalog = await admin.get('/v1/access/catalog').expect(200);
    catalogSchema.parse(catalog.body);
    const audit = await admin.get('/v1/access/audit').expect(200);
    const entries = pageSchema(auditEntrySchema.strict()).parse(audit.body);
    expect(entries.items.length).toBeGreaterThan(0);
  });

  it('finds users by name or address and API clients by name, as principal keys', async () => {
    const tag = randomUUID().slice(0, 6);
    const email = await member(`Ada ${tag}`);
    await member('Grace', `grace-${tag}@example.com`);
    const client = await node.client(`Billing ${tag}`);

    const found = await search({ q: tag });
    expect(labels(found.items)).toEqual([
      `Ada ${tag}`,
      `Billing ${tag}`,
      'Grace',
    ]);
    const ada = found.items.find((item) => item.label === `Ada ${tag}`)!;
    expect(ada).toMatchObject({ kind: 'user', email, active: true });
    expect(ada.key).toBe(`user:${ada.id}`);
    expect(found.items.find((item) => item.kind === 'client')).toEqual({
      id: client.id,
      key: `client:${client.id}`,
      kind: 'client',
      label: `Billing ${tag}`,
      email: null,
      active: true,
    });
    // Whatever the case; by address too.
    expect(
      labels((await search({ q: `GRACE-${tag.toUpperCase()}` })).items),
    ).toEqual(['Grace']);

    // One kind.
    expect(labels((await search({ q: tag, kind: 'client' })).items)).toEqual([
      `Billing ${tag}`,
    ]);
    expect(labels((await search({ q: tag, kind: 'user' })).items)).toEqual([
      `Ada ${tag}`,
      'Grace',
    ]);

    // The key is what a setting's user scope takes.
    await node
      .admin()
      .put('/v1/settings/testItems.richPreview')
      .send({ scope: 'user', scopeId: `client:${client.id}`, value: true })
      .expect(200);
  });

  it('pages, by cursor, newest first or by label', async () => {
    const tag = randomUUID().slice(0, 6);
    await member(`${tag} b`);
    await member(`${tag} a`);
    await node.client(`${tag} c`);

    const first = await search({ q: tag, limit: '2', count: 'true' });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await search({
      q: tag,
      limit: '2',
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(labels([...first.items, ...second.items])).toEqual([
      `${tag} a`,
      `${tag} b`,
      `${tag} c`,
    ]);
    // Newest first: the client was made last.
    expect(first.items[0].label).toBe(`${tag} c`);

    const sorted = await search({ q: tag, limit: '2', sort: 'label' });
    expect(sorted.items.map((item) => item.label)).toEqual([
      `${tag} a`,
      `${tag} b`,
    ]);
    const rest = await search({
      q: tag,
      limit: '2',
      sort: 'label',
      cursor: sorted.nextCursor!,
    });
    expect(rest.items.map((item) => item.label)).toEqual([`${tag} c`]);
  });

  it("never shows another tenant's users or clients", async () => {
    const tag = randomUUID().slice(0, 6);
    const other = await node.otherTenant();
    const theirs = await other.user([]);
    await other.client(`Elsewhere ${tag}`);
    await member(`Here ${tag}`);

    expect(labels((await search({ q: tag })).items)).toEqual([`Here ${tag}`]);
    const all = await search({ limit: '100' });
    expect(all.items.map((item) => item.id)).not.toContain(theirs.id);

    // Their administrator sees theirs, never ours.
    const fromThere = await search({ q: tag }, other.admin);
    expect(labels(fromThere.items)).toEqual([`Elsewhere ${tag}`]);
    const theirAll = await search({ limit: '100' }, other.admin);
    expect(theirAll.items.map((item) => item.label)).not.toContain(
      `Here ${tag}`,
    );
  });

  it('is refused to whoever may not list users or clients: 403', async () => {
    const editor = await node.user(['editor']);
    await editor.agent.get('/v1/access/users').expect(403);
    await editor.agent.get('/v1/access/principals').expect(403);
    await editor.agent.get('/v1/access/principals?q=a').expect(403);
    // An API key counts as no credentials on the access API.
    const client = await node.client();
    await node
      .http()
      .get('/v1/access/principals')
      .set('Authorization', client.auth)
      .expect(401);
  });

  it('searches `%` and `_` as the characters, and caps `q`', async () => {
    const tag = randomUUID().slice(0, 6);
    await member(`${tag} 100% sure`);
    await member(`${tag} 1000 sure`);
    await member(`${tag} a_b`);
    await member(`${tag} axb`);

    expect(labels((await search({ q: `${tag} 100%` })).items)).toEqual([
      `${tag} 100% sure`,
    ]);
    expect(labels((await search({ q: '0% s' })).items)).toEqual([
      `${tag} 100% sure`,
    ]);
    expect(labels((await search({ q: 'a_b' })).items)).toEqual([`${tag} a_b`]);
    expect((await search({ q: '%' })).items.map((item) => item.label)).toEqual([
      `${tag} 100% sure`,
    ]);

    await node
      .admin()
      .get('/v1/access/principals')
      .query({ q: 'x'.repeat(201) })
      .expect(400);
    await node
      .admin()
      .get('/v1/access/principals')
      .query({ q: '' })
      .expect(400);
    await node
      .admin()
      .get('/v1/access/principals')
      .query({ kind: 'system' })
      .expect(400);
  });
});
