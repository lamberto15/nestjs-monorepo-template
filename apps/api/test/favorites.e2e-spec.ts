import { bootApp, type TestApp } from './support.js';

type Favorite = { id: string; kind: string; target: string; label: string };

describe('favorites: pinned records, pages and views (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const list = async (agent: ReturnType<TestApp['admin']>) =>
    (await agent.get('/v1/favorites').expect(200)).body.items as Favorite[];

  it('pins what the user sees, in their order, once each, and theirs alone', async () => {
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);
    const item = (
      await node.writeItem(editor.agent, { title: 'Plan' }).expect(201)
    ).body as { id: string };
    const pinItem = (agent: ReturnType<TestApp['admin']>) =>
      agent.post('/v1/favorites').send({
        kind: 'record',
        subject: 'TestItem',
        target: item.id,
        label: 'Plan',
      });

    const record = (await pinItem(editor.agent).expect(201)).body as Favorite;
    const page = (
      await editor.agent
        .post('/v1/favorites')
        .send({ kind: 'page', target: '/test-items', label: 'Test items' })
        .expect(201)
    ).body as Favorite;
    // The same thing twice is refused; a record the user can't read can't be pinned (as if missing).
    await pinItem(editor.agent).expect(409);
    await pinItem(other.agent).expect(404);
    // Malformed: a record without its subject, a page that is no path.
    await editor.agent
      .post('/v1/favorites')
      .send({ kind: 'record', target: item.id, label: 'x' })
      .expect(400);
    await editor.agent
      .post('/v1/favorites')
      .send({ kind: 'page', target: 'notes', label: 'x' })
      .expect(400);

    expect((await list(editor.agent)).map((f) => f.id)).toEqual([
      record.id,
      page.id,
    ]);
    expect(await list(other.agent)).toEqual([]);

    // Reordered: every favorite once, else refused.
    await editor.agent
      .put('/v1/favorites/order')
      .send({ ids: [page.id] })
      .expect(400);
    const reordered = await editor.agent
      .put('/v1/favorites/order')
      .send({ ids: [page.id, record.id] })
      .expect(200);
    expect(reordered.body.items.map((f: Favorite) => f.id)).toEqual([
      page.id,
      record.id,
    ]);

    // Someone else's favorite is not theirs to remove.
    await other.agent.delete(`/v1/favorites/${page.id}`).expect(404);
    await editor.agent.delete(`/v1/favorites/${page.id}`).expect(204);
    expect((await list(editor.agent)).map((f) => f.id)).toEqual([record.id]);
  });

  it('pins a saved view its owner sees, with the list page it opens on', async () => {
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);
    const view = (
      await editor.agent
        .post('/v1/views')
        .send({ subject: 'TestItem', name: 'Mine' })
        .expect(201)
    ).body as { id: string };
    const pin = (agent: ReturnType<TestApp['admin']>) =>
      agent.post('/v1/favorites').send({
        kind: 'view',
        subject: '/test-items',
        target: view.id,
        label: 'Mine',
      });
    expect((await pin(editor.agent).expect(201)).body).toMatchObject({
      kind: 'view',
      subject: '/test-items',
      target: view.id,
    });
    // A private view is its owner's: someone else can't pin it.
    await pin(other.agent).expect(404);
  });

  it('leaves out a record once it is deleted, before showing its label', async () => {
    const editor = await node.user(['editor']);
    const item = (
      await node.writeItem(editor.agent, { title: 'Gone soon' }).expect(201)
    ).body as { id: string };
    await editor.agent
      .post('/v1/favorites')
      .send({
        kind: 'record',
        subject: 'TestItem',
        target: item.id,
        label: 'Gone soon',
      })
      .expect(201);
    expect(await list(editor.agent)).toHaveLength(1);

    await editor.agent.delete(`/v1/test-items/${item.id}`).expect(204);
    expect(await list(editor.agent)).toEqual([]);
  });
});
