import { OutboxRelay } from '@nestjs/outbox';
import { bootApp, type TestApp } from './support.js';

describe('record subscriptions: watching test items (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const deliver = () => node.app.get(OutboxRelay).runOnce();
  const comments = async (agent: ReturnType<TestApp['admin']>) =>
    (await agent.get('/v1/notifications?type=testItem.commented').expect(200))
      .body.items as { count: number; body: string; link: string }[];

  it('tells the watchers of a test item when someone else comments on it', async () => {
    const editor = await node.user(['editor']);
    const editorName = (await editor.agent.get('/v1/auth/me').expect(200)).body
      .user.name as string;
    const other = await node.user(['editor']);
    const item = (
      await node.writeItem(editor.agent, { title: 'Draft' }).expect(201)
    ).body as { id: string };
    const comment = (agent: ReturnType<TestApp['admin']>, body: string) =>
      agent.post(`/v1/test-items/${item.id}/comments`).send({ body });

    // The owner watches from the start; someone who can't read it can't watch.
    const mine = await editor.agent.get('/v1/subscriptions').expect(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ subject: 'TestItem', recordId: item.id }),
    ]);
    const refused = await other.agent.post(`/v1/test-items/${item.id}/watch`);
    expect([403, 404]).toContain(refused.status);

    // The administrator comments twice: one collapsed notification for the owner, none for themselves.
    await comment(node.admin(), 'First.').expect(201);
    await comment(node.admin(), 'Second.').expect(201);
    await deliver();
    expect(await comments(editor.agent)).toEqual([
      expect.objectContaining({
        count: 2,
        body: '2 new comments on "Draft"; the latest by Administrator: Second.',
        link: `/test-items/${item.id}`,
      }),
    ]);
    expect(await comments(node.admin())).toEqual([]);

    // Commenting made the administrator a watcher: the owner's comment reaches them, and not the owner again.
    expect(
      (await node.admin().get('/v1/subscriptions').expect(200)).body.items,
    ).toEqual([
      expect.objectContaining({ subject: 'TestItem', recordId: item.id }),
    ]);
    await comment(editor.agent, 'Mine.').expect(201);
    await deliver();
    expect(await comments(node.admin())).toEqual([
      expect.objectContaining({
        count: 1,
        body: `${editorName} commented on "Draft": Mine.`,
      }),
    ]);
    expect((await comments(editor.agent))[0]!.count).toBe(2);

    // Watching ends from either side; then a comment tells nobody new.
    await node
      .admin()
      .delete(`/v1/subscriptions/TestItem/${item.id}`)
      .expect(204);
    await node
      .admin()
      .delete(`/v1/subscriptions/TestItem/${item.id}`)
      .expect(404);
    await editor.agent.delete(`/v1/test-items/${item.id}/watch`).expect(204);
    expect(
      (await editor.agent.get('/v1/subscriptions').expect(200)).body.items,
    ).toEqual([]);
    expect(
      (await editor.agent.get('/v1/subscriptions?subject=Nope').expect(200))
        .body.items,
    ).toEqual([]);
    // Commenting watches again, for the commenter only.
    await comment(node.admin(), 'Nobody else watches.').expect(201);
    await deliver();
    expect((await comments(editor.agent))[0]!.count).toBe(2);
    expect(await comments(node.admin())).toHaveLength(1);
  });
});
