import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

describe('notes access control (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  it('shows the notes subject in the catalog', async () => {
    const catalog = await node.admin().get('/v1/access/catalog').expect(200);
    const subjects = catalog.body.subjects as { subject: string }[];
    expect(subjects.map((s) => s.subject)).toContain('Note');
  });

  it('tells an editor what they may do with notes', async () => {
    const editor = (await node.user(['editor'])).agent;
    const me = await editor.get('/v1/auth/me').expect(200);
    expect(me.body.can).toMatchObject({
      'Note.create': true,
      'Note.read': true, // their own notes: allowed on some records
    });
  });

  it('takes the draft condition where the catalog declares it (update), and refuses it elsewhere (read): 400', async () => {
    await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: 'Drafts',
        permissions: [
          { subject: 'Note', action: 'update', conditions: [{ key: 'draft' }] },
        ],
      })
      .expect(201);
    await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: 'Bad',
        permissions: [
          { subject: 'Note', action: 'read', conditions: [{ key: 'draft' }] },
        ],
      })
      .expect(400);
  });

  it('lets a lead see the notes of the units they lead and every unit below them', async () => {
    const admin = node.admin();
    const unit = async (name: string, parentId?: string) =>
      (
        await admin
          .post('/v1/access/organizational-units')
          .send({ type: 'team', name, parentId })
          .expect(201)
      ).body.id as string;
    const sales = await unit('Sales');
    const north = await unit('North', sales);
    const south = await unit('South', sales);
    const northEast = await unit('North East', north);

    // Members write notes in their units.
    const [lead] = await node.roleIds('unit-lead');
    const member = async (unitId: string) => {
      const created = await node.user(['editor']);
      await admin
        .post(`/v1/access/organizational-units/${unitId}/members`)
        .send({ userId: created.id })
        .expect(201);
      return created.agent;
    };
    await writeNote(node, await member(northEast), {
      title: 'From North East',
      body: 'x',
    }).expect(201);
    await writeNote(node, await member(south), {
      title: 'From South',
      body: 'x',
    }).expect(201);

    const leadOf = async (unitId: string) => {
      const created = await node.user([lead]);
      await admin
        .post(`/v1/access/organizational-units/${unitId}/members`)
        .send({ userId: created.id, role: 'lead' })
        .expect(201);
      const notes = (await created.agent.get('/v1/notes').expect(200)).body
        .items as { title: string }[];
      return notes.map((note) => note.title).sort((a, b) => a.localeCompare(b));
    };
    expect(await leadOf(sales)).toEqual(['From North East', 'From South']);
    expect(await leadOf(north)).toEqual(['From North East']);
    expect(await leadOf(south)).toEqual(['From South']);
  });
});
