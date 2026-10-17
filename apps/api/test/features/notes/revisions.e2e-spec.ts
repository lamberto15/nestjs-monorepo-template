import { bootApp, type TestApp } from '../../support.js';

type Agent = ReturnType<TestApp['admin']>;
interface Revision {
  number: number;
  snapshot: Record<string, unknown>;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  restoredFrom: number | null;
  changedBy: string;
}

describe('record revisions of notes: custom fields (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const patch = (agent: Agent, id: string, body: Record<string, unknown>) =>
    agent.patch(`/v1/notes/${id}`).send(body).expect(200);
  const revisions = async (agent: Agent, id: string, query = '') =>
    (await agent.get(`/v1/notes/${id}/revisions${query}`).expect(200)).body as {
      items: Revision[];
      nextCursor: string | null;
    };

  it('keeps custom values in the snapshots and restores them', async () => {
    const field = await node
      .admin()
      .post('/v1/custom-fields')
      .send({ subject: 'Note', key: 'region', label: 'Region', type: 'text' })
      .expect(201);
    const editor = await node.user(['editor']);
    const created = await node
      .writeNote(editor.agent, {
        title: 'Plan',
        body: 'x',
        custom: { region: 'eu' },
      })
      .expect(201);
    const id = created.body.id as string;
    await patch(editor.agent, id, { custom: { region: 'us' } });
    await patch(editor.agent, id, { custom: { region: null } });

    const page = await revisions(editor.agent, id);
    expect(page.items.map((r) => r.snapshot.custom)).toEqual([
      {},
      { region: 'us' },
      { region: 'eu' },
    ]);
    expect(page.items[1]!.changes).toEqual({
      'custom.region': { from: 'eu', to: 'us' },
    });
    expect(page.items[0]!.changes).toEqual({
      'custom.region': { from: 'us', to: null },
    });

    const restored = await editor.agent
      .post(`/v1/notes/${id}/revisions/1/restore`)
      .expect(200);
    expect(restored.body.custom).toEqual({ region: 'eu' });

    // A field deactivated since: hidden in snapshots, changes and diffs.
    await node
      .admin()
      .patch(`/v1/custom-fields/${field.body.id}`)
      .send({ active: false })
      .expect(200);
    const hidden = await revisions(editor.agent, id);
    for (const revision of hidden.items) {
      expect(revision.snapshot.custom).toEqual({});
      expect(Object.keys(revision.changes ?? {})).not.toContain(
        'custom.region',
      );
    }
    expect(
      (await editor.agent.get(`/v1/notes/${id}/revisions/1/diff/2`).expect(200))
        .body.changes,
    ).toEqual({});
  });
});
