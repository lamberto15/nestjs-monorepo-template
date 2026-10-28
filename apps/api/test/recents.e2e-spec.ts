import { eq } from 'drizzle-orm';
import { RecentsRetentionJob } from '../src/platform/recents/recents-retention.job.js';
import { MAX_RECENTS } from '../src/platform/recents/recent.schemas.js';
import { recentRecords } from '../src/platform/recents/recents.tables.js';
import { bootApp, type TestApp } from './support.js';

type Recent = { id: string; subject: string; recordId: string; label: string };
type Agent = ReturnType<TestApp['admin']>;

describe('recents: recently opened records (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const list = async (agent: Agent) =>
    (await agent.get('/v1/recents').expect(200)).body.items as Recent[];
  const open = (agent: Agent, recordId: string, label = 'Plan') =>
    agent.post('/v1/recents').send({ subject: 'TestItem', recordId, label });
  const item = async (agent: Agent, title: string) =>
    (await node.writeItem(agent, { title }).expect(201)).body as { id: string };

  it('lists what the user opened, newest first, once each, and theirs alone', async () => {
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);
    const first = await item(editor.agent, 'First');
    const second = await item(editor.agent, 'Second');

    await open(editor.agent, first.id, 'First').expect(200);
    await open(editor.agent, second.id, 'Second').expect(200);
    // Opening one again moves it up, it is not listed twice.
    await open(editor.agent, first.id, 'First, renamed').expect(200);
    expect(
      (await list(editor.agent)).map((r) => [r.recordId, r.label]),
    ).toEqual([
      [first.id, 'First, renamed'],
      [second.id, 'Second'],
    ]);

    // Someone who can't read the record can't note it (as if missing), and has their own list.
    await open(other.agent, first.id).expect(404);
    expect(await list(other.agent)).toEqual([]);
    // Malformed: no subject shape, no id.
    await editor.agent
      .post('/v1/recents')
      .send({ subject: 'x', recordId: first.id, label: 'x' })
      .expect(400);
    await editor.agent
      .post('/v1/recents')
      .send({ subject: 'TestItem', recordId: 'nope', label: 'x' })
      .expect(400);
  });

  it('is bounded, removes one, and is cleared by its owner', async () => {
    const editor = await node.user(['editor']);
    const ids: string[] = [];
    for (let i = 0; i <= MAX_RECENTS; i++) {
      const created = await item(editor.agent, `Item ${i}`);
      ids.push(created.id);
      await open(editor.agent, created.id, `Item ${i}`).expect(200);
    }
    const recents = await list(editor.agent);
    // The oldest dropped out.
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(recents.map((r) => r.recordId)).not.toContain(ids[0]);
    expect(recents[0]!.recordId).toBe(ids.at(-1));

    await editor.agent.delete(`/v1/recents/${recents[0]!.id}`).expect(204);
    await editor.agent.delete(`/v1/recents/${recents[0]!.id}`).expect(404);
    expect(await list(editor.agent)).toHaveLength(MAX_RECENTS - 1);

    await editor.agent.delete('/v1/recents').expect(204);
    expect(await list(editor.agent)).toEqual([]);
  });

  it('leaves out a record once it is deleted or no longer seen, and keeps tenants apart', async () => {
    const editor = await node.user(['editor']);
    const tenant = await node.otherTenant();
    const stranger = await tenant.user(['editor']);
    const gone = await item(editor.agent, 'Gone soon');
    await open(editor.agent, gone.id, 'Gone soon').expect(200);
    expect(await list(editor.agent)).toHaveLength(1);
    await editor.agent.delete(`/v1/test-items/${gone.id}`).expect(204);
    expect(await list(editor.agent)).toEqual([]);

    // Another tenant's user neither notes nor sees this tenant's records.
    const kept = await item(editor.agent, 'Kept');
    await open(editor.agent, kept.id, 'Kept').expect(200);
    await open(stranger.agent, kept.id).expect(404);
    expect(await list(stranger.agent)).toEqual([]);
  });

  it('deletes entries past the retention on the nightly sweep and never lists them', async () => {
    const editor = await node.user(['editor']);
    const old = await item(editor.agent, 'Old');
    const fresh = await item(editor.agent, 'Fresh');
    await open(editor.agent, old.id, 'Old').expect(200);
    await open(editor.agent, fresh.id, 'Fresh').expect(200);
    await node.acrossTenants(() =>
      node.db
        .update(recentRecords)
        .set({ viewedAt: new Date(Date.now() - 40 * 86_400_000) })
        .where(eq(recentRecords.recordId, old.id)),
    );
    // Expired is not listed even before the sweep…
    expect((await list(editor.agent)).map((r) => r.recordId)).toEqual([
      fresh.id,
    ]);
    // …and the sweep deletes it.
    expect(await node.app.get(RecentsRetentionJob).run()).toBe(1);
  });
});
