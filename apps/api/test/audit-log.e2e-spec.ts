import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { pageSchema } from '../src/core/http/pagination.js';
import { auditEntrySchema } from '../src/iam/access/access.schemas.js';
import { auditLog } from '../src/iam/iam.tables.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The audit log as a generic list (GET /v1/lists/Audit), its entries found
 * by who acted by name or address (`actorLabel`), never another tenant's
 * people; and the global search naming each hit's subject in the request's
 * language (#130).
 */
describe('audit log and search labels (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A role made of these permissions (no conditions), by id. */
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

  /** An editor of the seeded tenant with this name and address, signed in. */
  async function editorNamed(name: string, email: string) {
    const token = await node.invite(node.admin(), {
      email,
      name,
      roleIds: await node.roleIds('editor'),
    });
    const password = await node.acceptAsNew(token);
    const agent = await node.signIn(email, password);
    const me = await agent.get('/v1/auth/me').expect(200);
    return { id: me.body.user.id as string, agent };
  }

  const audit = async (
    query: Record<string, string>,
    agent: request.Agent = node.admin(),
  ) =>
    pageSchema(auditEntrySchema.strict()).parse(
      (
        await agent
          .get('/v1/access/audit')
          .query({ limit: '100', ...query })
          .expect(200)
      ).body,
    ).items;
  const actors = (items: { actor: string }[]) =>
    [...new Set(items.map((item) => item.actor))].sort((a, b) =>
      a.localeCompare(b),
    );

  it('describes the audit list at GET /v1/lists/Audit, to whoever may read the log', async () => {
    const { body } = await node.admin().get('/v1/lists/Audit').expect(200);
    expect(body.subject).toBe('Audit');
    expect(body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'actor',
          operators: ['eq', 'in'],
          ref: 'principal',
        }),
        expect.objectContaining({
          name: 'actorLabel',
          type: 'string',
          operators: ['eq', 'contains', 'startsWith'],
          sortable: false,
        }),
        expect.objectContaining({ name: 'at', sortable: true }),
        expect.objectContaining({ name: 'action', sortable: true }),
      ]),
    );
    expect(body.select).toEqual(
      expect.arrayContaining(['action', 'actor', 'actorLabel', 'details']),
    );
    expect(body.search).toBe(false);
    expect(body.recycleBin).toBe(false);
    expect(body.capabilities.comments).toBe(false);

    // readAudit alone is enough; another access permission is not.
    const auditor = await node.user([await role(['Access', 'readAudit'])]);
    await auditor.agent.get('/v1/lists/Audit').expect(200);
    const units = await node.user([
      await role(['Access', 'manageOrganizationalUnits']),
    ]);
    await units.agent.get('/v1/lists/User').expect(200);
    await units.agent.get('/v1/lists/Audit').expect(403);
    const editor = await node.user(['editor']);
    await editor.agent.get('/v1/lists/Audit').expect(403);
  });

  it("finds entries by the actor's name, address or the label they stored", async () => {
    const tag = randomUUID().slice(0, 8);
    const ada = await editorNamed(`Ada ${tag}`, `ada-${tag}@example.com`);
    await node.writeItem(ada.agent, { title: 'By Ada' }).expect(201);
    const client = await node.client(`Billing ${tag}`);
    await node.writeItem(client.auth, { title: 'By Billing' }).expect(201);

    // By name, whatever the case: Ada (a member) and the client.
    expect(actors(await audit({ 'actorLabel.contains': tag }))).toEqual(
      [`client:${client.id}`, `user:${ada.id}`].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect(
      actors(
        await audit({ 'actorLabel.contains': `ada ${tag.toUpperCase()}` }),
      ),
    ).toEqual([`user:${ada.id}`]);
    // By address: the whole of it (eq, whatever the case), or its start.
    expect(
      actors(await audit({ actorLabel: `ADA-${tag}@example.com` })),
    ).toEqual([`user:${ada.id}`]);
    expect(
      actors(await audit({ 'actorLabel.startsWith': `ada-${tag}` })),
    ).toEqual([`user:${ada.id}`]);
    // A client by its name; with the other filters.
    const created = await audit({
      'actorLabel.startsWith': `Billing ${tag}`,
      action: 'testItem.created',
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      actor: `client:${client.id}`,
      actorLabel: `Billing ${tag}`,
    });
    // In `filter` too.
    expect(
      actors(
        await audit({
          filter: JSON.stringify({
            or: [
              { field: 'actorLabel', op: 'contains', value: `Ada ${tag}` },
              { field: 'actor', op: 'eq', value: 'system:nobody' },
            ],
          }),
        }),
      ),
    ).toEqual([`user:${ada.id}`]);
    // `%` and `_` are the characters.
    expect(await audit({ 'actorLabel.contains': `${tag}%` })).toEqual([]);
    expect(await audit({ 'actorLabel.contains': 'a_a-' })).toEqual([]);
    expect(await audit({ 'actorLabel.contains': `nobody-${tag}` })).toEqual([]);
  });

  it("names each entry's actor as they are called now (actorName), next to the label it stored", async () => {
    const tag = randomUUID().slice(0, 8);
    const ada = await editorNamed(`Ada ${tag}`, `ada-${tag}@example.com`);
    await node.writeItem(ada.agent, { title: 'By Ada' }).expect(201);
    const client = await node.client(`Billing ${tag}`);
    await node.writeItem(client.auth, { title: 'By Billing' }).expect(201);
    // Actors with no name in the tenant: a system job, someone unknown.
    const ghost = `user:${randomUUID()}`;
    await node.db.insert(auditLog).values(
      ['system:nightly', ghost].map((actor) => ({
        tenantId: node.tenantId,
        actor,
        actorLabel: `label of ${actor}`,
        action: `test.${tag}`,
      })),
    );

    const created = await audit({
      action: 'testItem.created',
      'actor.in': `user:${ada.id},client:${client.id}`,
    });
    const named = (actor: string) =>
      created.find((entry) => entry.actor === actor);
    // The member: the address the entry stored, the name they have now.
    expect(named(`user:${ada.id}`)).toMatchObject({
      actorLabel: `ada-${tag}@example.com`,
      actorName: `Ada ${tag}`,
    });
    expect(named(`client:${client.id}`)).toMatchObject({
      actorLabel: `Billing ${tag}`,
      actorName: `Billing ${tag}`,
    });
    // Nobody named: null, the label is what there is.
    expect(
      Object.fromEntries(
        (await audit({ action: `test.${tag}` })).map((entry) => [
          entry.actor,
          entry.actorName,
        ]),
      ),
    ).toEqual({ 'system:nightly': null, [ghost]: null });
    // `fields=` picks it like any other.
    const picked = (
      await node
        .admin()
        .get('/v1/access/audit')
        .query({ actor: `user:${ada.id}`, fields: 'actorName' })
        .expect(200)
    ).body.items as Record<string, unknown>[];
    expect(picked.length).toBeGreaterThan(0);
    expect(Object.keys(picked[0]!).sort((a, b) => a.localeCompare(b))).toEqual([
      'actorName',
      'id',
    ]);
  });

  it('is refused to whoever may not read the audit log', async () => {
    const units = await node.user([
      await role(['Access', 'manageOrganizationalUnits']),
    ]);
    await units.agent.get('/v1/access/audit?actorLabel.contains=a').expect(403);
    await node
      .admin()
      .get('/v1/access/audit?actorLabel.endsWith=a')
      .expect(400);
  });

  describe('security', () => {
    it("never matches another tenant's users or clients, nor shows their entries", async () => {
      const tag = randomUUID().slice(0, 8);
      const other = await node.otherTenant();
      const theirs = await other.user(['editor']);
      await node.writeItem(theirs.agent, { title: 'Theirs' }).expect(201);
      const theirClient = await other.client(`Elsewhere ${tag}`);
      await node
        .writeItem(theirClient.auth, { title: 'Theirs too' })
        .expect(201);

      // Our administrator: nothing of theirs, by address or by name.
      expect(await audit({ 'actorLabel.contains': theirs.email })).toEqual([]);
      expect(await audit({ actorLabel: theirs.email })).toEqual([]);
      expect(await audit({ 'actorLabel.contains': tag })).toEqual([]);
      // Their administrator finds theirs.
      expect(
        actors(await audit({ actorLabel: theirs.email }, other.admin)),
      ).toEqual([`user:${theirs.id}`]);
      expect(
        actors(await audit({ 'actorLabel.contains': tag }, other.admin)),
      ).toEqual([`client:${theirClient.id}`]);
    });
  });

  it("names each search hit's subject in the request's language", async () => {
    const editor = await node.user(['editor']);
    const tag = randomUUID().slice(0, 8);
    await node.writeItem(editor.agent, { title: `Zebra ${tag}` }).expect(201);

    const english = await editor.agent.get(`/v1/search?q=${tag}`).expect(200);
    expect(english.body.items).toHaveLength(1);
    expect(english.body.items[0]).toMatchObject({
      subject: 'TestItem',
      subjectLabel: { singular: 'Test item', plural: 'Test items' },
    });
    const german = await editor.agent
      .get(`/v1/search?q=${tag}&lang=de`)
      .expect(200);
    expect(german.body.items[0]).toMatchObject({
      subject: 'TestItem',
      subjectLabel: { singular: 'Testeintrag', plural: 'Testeinträge' },
    });
  });
});
