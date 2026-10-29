import { bootApp, type TestApp } from './support.js';

describe('record presence (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  it('shows who is on a record to those who read it, and to nobody else', async () => {
    const editor = await node.user(['editor']);
    const colleague = await node.user(['viewer']);
    const tenant = await node.otherTenant();
    const stranger = await tenant.user(['editor']);
    const item = (
      await node.writeItem(editor.agent, { title: 'Plan' }).expect(201)
    ).body as { id: string };
    const path = `/v1/presence/TestItem/${item.id}`;

    await editor.agent.put(path).send({ mode: 'editing' }).expect(200);
    const seen = await colleague.agent
      .put(path)
      .send({ mode: 'viewing' })
      .expect(200);
    expect(seen.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `user:${editor.id}`,
          mode: 'editing',
          self: false,
        }),
        expect.objectContaining({
          key: `user:${colleague.id}`,
          mode: 'viewing',
          self: true,
        }),
      ]),
    );
    // Only the mode is kept: a malformed one is refused.
    await editor.agent.put(path).send({ mode: 'typing' }).expect(400);

    // Another tenant's user neither sees the record's room nor joins it.
    await stranger.agent.get(path).expect(404);
    await stranger.agent.put(path).send({ mode: 'viewing' }).expect(404);

    await colleague.agent.delete(path).expect(204);
    const left = await editor.agent.get(path).expect(200);
    expect(left.body.items.map((i: { key: string }) => i.key)).toEqual([
      `user:${editor.id}`,
    ]);
  });
});
