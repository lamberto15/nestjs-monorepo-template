import { OutboxRelay } from '@nestjs/outbox';
import { bootApp, type TestApp } from './support.js';

describe('record subscriptions: watching notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const deliver = () => node.app.get(OutboxRelay).runOnce();
  const changes = async (agent: ReturnType<TestApp['admin']>) =>
    (await agent.get('/v1/notifications?type=note.changed').expect(200)).body
      .items as { count: number; body: string; link: string }[];

  it('tells the watchers of a note when someone else changes or publishes it', async () => {
    const editor = await node.user(['editor']);
    const editorName = (await editor.agent.get('/v1/auth/me').expect(200)).body
      .user.name as string;
    const other = await node.user(['editor']);
    const note = (
      await node
        .writeNote(editor.agent, { title: 'Draft', body: '' })
        .expect(201)
    ).body as { id: string };

    // The owner watches from the start; someone who can't read it can't watch.
    const mine = await editor.agent.get('/v1/subscriptions').expect(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ subject: 'Note', recordId: note.id }),
    ]);
    const refused = await other.agent.post(`/v1/notes/${note.id}/watch`);
    expect([403, 404]).toContain(refused.status);

    // The administrator changes it twice: one collapsed notification for the owner, none for themselves.
    await node
      .admin()
      .patch(`/v1/notes/${note.id}`)
      .send({ title: 'Edited' })
      .expect(200);
    await node
      .admin()
      .patch(`/v1/notes/${note.id}`)
      .send({ title: 'Edited twice' })
      .expect(200);
    await deliver();
    expect(await changes(editor.agent)).toEqual([
      expect.objectContaining({
        count: 2,
        body: '2 changes to "Edited twice"; the latest by Administrator.',
        link: `/notes/${note.id}`,
      }),
    ]);
    expect(await changes(node.admin())).toEqual([]);

    // The administrator watches it: the owner's own change reaches them, and not the owner again.
    expect(
      (await node.admin().post(`/v1/notes/${note.id}/watch`).expect(200)).body,
    ).toEqual({ watching: true });
    await editor.agent
      .patch(`/v1/notes/${note.id}`)
      .send({ body: 'mine' })
      .expect(200);
    await deliver();
    expect(await changes(node.admin())).toEqual([
      expect.objectContaining({
        count: 1,
        body: `${editorName} changed "Edited twice".`,
      }),
    ]);
    expect((await changes(editor.agent))[0]!.count).toBe(2);

    // Published: the owner and the watcher are told.
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    await deliver();
    for (const agent of [editor.agent, node.admin()]) {
      const published = await agent
        .get('/v1/notifications?type=note.published')
        .expect(200);
      expect(published.body.items).toHaveLength(1);
    }

    // Watching ends from either side; then a change tells nobody new.
    await node.admin().delete(`/v1/subscriptions/Note/${note.id}`).expect(204);
    await node.admin().delete(`/v1/subscriptions/Note/${note.id}`).expect(404);
    await editor.agent.delete(`/v1/notes/${note.id}/watch`).expect(204);
    expect(
      (await editor.agent.get('/v1/subscriptions').expect(200)).body.items,
    ).toEqual([]);
    expect(
      (await editor.agent.get('/v1/subscriptions?subject=Nope').expect(200))
        .body.items,
    ).toEqual([]);
    await node
      .admin()
      .patch(`/v1/notes/${note.id}`)
      .send({ title: 'Nobody watches' })
      .expect(200);
    await deliver();
    expect((await changes(editor.agent))[0]!.count).toBe(2);
    expect(await changes(node.admin())).toHaveLength(1);
  });
});
