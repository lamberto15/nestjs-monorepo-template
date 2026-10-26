import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { SoftDeletePurgeJob } from '../src/iam/resources/soft-delete-purge.job.js';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import { comments } from '../src/platform/comments/comments.tables.js';
import { revisions as revisionsTable } from '../src/platform/revisions/revisions.tables.js';
import { recordSubscriptions } from '../src/platform/subscriptions/subscriptions.tables.js';
import { recordTags } from '../src/platform/tags/tags.tables.js';
import { RevisionRetentionJob } from '../src/platform/revisions/revision-retention.job.js';
import { TestItemsService } from './fixtures/test-items/test-items.service.js';
import { bootApp, type TestApp } from './support.js';

type Agent = ReturnType<TestApp['admin']>;
interface Revision {
  number: number;
  snapshot: Record<string, unknown>;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  restoredFrom: number | null;
  changedBy: string;
  changedByName: string | null;
}

describe('record revisions of test items (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const writeItem = async (agent: Agent, title = 'Draft', body = 'v1') =>
    (await node.writeItem(agent, { title, body }).expect(201)).body
      .id as string;
  const patch = (agent: Agent, id: string, body: Record<string, unknown>) =>
    agent.patch(`/v1/test-items/${id}`).send(body).expect(200);
  const revisions = async (agent: Agent, id: string, query = '') =>
    (await agent.get(`/v1/test-items/${id}/revisions${query}`).expect(200))
      .body as {
      items: Revision[];
      nextCursor: string | null;
    };

  it('keeps revision 1 on create and one per change, newest first, with what changed', async () => {
    const editor = await node.user(['editor']);
    const id = await writeItem(editor.agent);
    await patch(editor.agent, id, { title: 'Plan' });
    await patch(editor.agent, id, { body: 'v2' });
    // Nothing changes: no revision.
    await patch(editor.agent, id, { body: 'v2' });

    const page = await revisions(editor.agent, id);
    expect(page.items.map((r) => r.number)).toEqual([3, 2, 1]);
    expect(page.items[2]).toMatchObject({
      number: 1,
      snapshot: { title: 'Draft', body: 'v1' },
      changes: null,
      restoredFrom: null,
      changedBy: `user:${editor.id}`,
      // Their name, as every member sees it (node.user() names them by address).
      changedByName: editor.email,
    });
    expect(page.items[1]!.changes).toEqual({
      title: { from: 'Draft', to: 'Plan' },
    });
    expect(page.items[0]).toMatchObject({
      snapshot: { title: 'Plan', body: 'v2' },
      changes: { body: { from: 'v1', to: 'v2' } },
    });

    // Cursor pages, newest first.
    const first = await revisions(editor.agent, id, '?limit=2');
    expect(first.items.map((r) => r.number)).toEqual([3, 2]);
    const second = await revisions(
      editor.agent,
      id,
      `?limit=2&cursor=${first.nextCursor}`,
    );
    expect(second.items.map((r) => r.number)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    await editor.agent
      .get(`/v1/test-items/${id}/revisions?cursor=nonsense`)
      .expect(400);
    // Another test item's cursor is none of this one's: nothing after it.
    const other = await writeItem(editor.agent);
    const foreign = (await revisions(editor.agent, other)).items as unknown as {
      id: string;
    }[];
    expect(
      (await revisions(editor.agent, id, `?cursor=${foreign[0]!.id}`)).items,
    ).toEqual([]);

    // One, and an unknown one.
    const two = await editor.agent
      .get(`/v1/test-items/${id}/revisions/2`)
      .expect(200);
    expect(two.body).toMatchObject({ number: 2, snapshot: { title: 'Plan' } });
    await editor.agent.get(`/v1/test-items/${id}/revisions/9`).expect(404);
    await editor.agent.get(`/v1/test-items/${id}/revisions/0`).expect(404);
    await editor.agent.get(`/v1/test-items/${id}/revisions/x`).expect(400);

    // The diff between 1 and 3, both ways.
    const diff = await editor.agent
      .get(`/v1/test-items/${id}/revisions/1/diff/3`)
      .expect(200);
    expect(diff.body).toEqual({
      from: 1,
      to: 3,
      changes: {
        title: { from: 'Draft', to: 'Plan' },
        body: { from: 'v1', to: 'v2' },
      },
    });
    const back = await editor.agent
      .get(`/v1/test-items/${id}/revisions/3/diff/1`)
      .expect(200);
    expect(back.body.changes.title).toEqual({ from: 'Plan', to: 'Draft' });
    await editor.agent
      .get(`/v1/test-items/${id}/revisions/1/diff/7`)
      .expect(404);
  });

  it('restores a revision through the update: audited, a new revision marked restoredFrom, If-Match honoured', async () => {
    const editor = await node.user(['editor']);
    const viewer = await node.user(['viewer']);
    const id = await writeItem(editor.agent);
    await patch(editor.agent, id, { title: 'Plan' });
    const read = await editor.agent.get(`/v1/test-items/${id}`).expect(200);
    const etag = read.headers.etag as string;

    // A viewer reads revisions but restores none.
    expect((await revisions(viewer.agent, id)).items).toHaveLength(2);
    await viewer.agent.get(`/v1/test-items/${id}/revisions/1`).expect(200);
    await viewer.agent
      .post(`/v1/test-items/${id}/revisions/1/restore`)
      .expect(403);

    // Changed since it was read: 412, nothing written.
    await patch(editor.agent, id, { body: 'v2' });
    const stale = await editor.agent
      .post(`/v1/test-items/${id}/revisions/1/restore`)
      .set('If-Match', etag)
      .expect(412);
    expect(stale.body.code).toBe('precondition_failed');
    expect((await revisions(editor.agent, id)).items).toHaveLength(3);

    const current = await editor.agent.get(`/v1/test-items/${id}`).expect(200);
    const restored = await editor.agent
      .post(`/v1/test-items/${id}/revisions/1/restore`)
      .set('If-Match', current.headers.etag as string)
      .expect(200);
    expect(restored.body).toMatchObject({ id, title: 'Draft', body: 'v1' });
    expect(restored.headers.etag).toBeDefined();
    // Answered as GET answers it.
    const after = await editor.agent.get(`/v1/test-items/${id}`).expect(200);
    expect(after.body).toEqual(restored.body);

    const latest = (await revisions(editor.agent, id)).items[0]!;
    expect(latest).toMatchObject({
      number: 4,
      restoredFrom: 1,
      snapshot: { title: 'Draft', body: 'v1' },
      changes: {
        title: { from: 'Plan', to: 'Draft' },
        body: { from: 'v2', to: 'v1' },
      },
    });
    const audit = await node
      .admin()
      .get(`/v1/access/audit?targetId=${id}`)
      .expect(200);
    expect(audit.body.items[0]).toMatchObject({
      action: 'testItem.updated',
      details: {
        changes: {
          title: { from: 'Plan', to: 'Draft' },
          body: { from: 'v2', to: 'v1' },
        },
      },
    });
    await editor.agent
      .post(`/v1/test-items/${id}/revisions/8/restore`)
      .expect(404);
  });

  it('builds the restore patch from the row locked after an intervening edit', async () => {
    const editor = await node.user(['editor']);
    const id = await writeItem(editor.agent);
    const service = node.app.get(TestItemsService);
    const originalUpdate = service.update.bind(service);
    let interposed = false;
    vi.spyOn(service, 'update').mockImplementation(async (...args) => {
      const [by, row, _dto, ip, options] = args;
      if (options?.restoredFrom === 1 && !interposed) {
        interposed = true;
        await originalUpdate(by, row, { title: 'Intervening edit' }, ip);
      }
      return originalUpdate(...args);
    });

    const restored = await editor.agent
      .post(`/v1/test-items/${id}/revisions/1/restore`)
      .expect(200);
    expect(interposed).toBe(true);
    expect(restored.body).toMatchObject({ id, title: 'Draft', body: 'v1' });
    expect((await revisions(editor.agent, id)).items[0]).toMatchObject({
      restoredFrom: 1,
      snapshot: { title: 'Draft', body: 'v1' },
      changes: { title: { from: 'Intervening edit', to: 'Draft' } },
    });
  });

  it("hides another's record (404) and an unknown one", async () => {
    const editor = await node.user(['editor']);
    const stranger = await node.user(['editor']);
    const id = await writeItem(editor.agent);
    await stranger.agent.get(`/v1/test-items/${id}/revisions`).expect(404);
    await stranger.agent.get(`/v1/test-items/${id}/revisions/1`).expect(404);
    await stranger.agent
      .get(`/v1/test-items/${id}/revisions/1/diff/1`)
      .expect(404);
    await stranger.agent
      .post(`/v1/test-items/${id}/revisions/1/restore`)
      .expect(404);
    const client = await node.client();
    await node
      .http()
      .get(`/v1/test-items/${id}/revisions`)
      .set('Authorization', client.auth)
      .expect(404);
    await editor.agent
      .get(`/v1/test-items/${randomUUID()}/revisions`)
      .expect(404);
  });

  it('retention deletes old revisions but keeps the latest of each test item', async () => {
    const editor = await node.user(['editor']);
    const changed = await writeItem(editor.agent);
    await patch(editor.agent, changed, { title: 'Plan' });
    await patch(editor.agent, changed, { title: 'Final' });
    const untouched = await writeItem(editor.agent);

    const job = node.app.get(RevisionRetentionJob);
    expect(await job.run()).toBe(0); // nothing is old yet
    expect(await job.run(new Date(Date.now() + 366 * 86_400_000))).toBe(2);
    expect(
      (await revisions(editor.agent, changed)).items.map((r) => r.number),
    ).toEqual([3]);
    expect(
      (await revisions(editor.agent, untouched)).items.map((r) => r.number),
    ).toEqual([1]);
    // The next change still numbers on, diffed against the latest kept.
    await patch(editor.agent, changed, { title: 'Again' });
    expect((await revisions(editor.agent, changed)).items[0]).toMatchObject({
      number: 4,
      changes: { title: { from: 'Final', to: 'Again' } },
    });
  });

  it('anonymizes who made a change when their account is deleted', async () => {
    const { id: adaId, password, agent: ada } = await node.user(['editor']);
    const created = { body: { id: adaId } };
    const id = await writeItem(ada);
    await patch(ada, id, { title: 'Plan' });
    expect(
      (await revisions(node.admin(), id)).items.map((r) => r.changedBy),
    ).toEqual([`user:${created.body.id}`, `user:${created.body.id}`]);

    await ada.post('/v1/account/deletion').send({ password }).expect(200);
    await node.app
      .get(AccountDeletionJob)
      .run(new Date(Date.now() + 15 * 86_400_000));
    expect(
      (await revisions(node.admin(), id)).items.map((r) => r.changedBy),
    ).toEqual(['anonymized', 'anonymized']);
    expect(
      (await revisions(node.admin(), id)).items.map((r) => r.changedByName),
    ).toEqual([null, null]);
  });

  it('restoring the current state writes nothing', async () => {
    const editor = await node.user(['editor']);
    const id = await writeItem(editor.agent);
    await patch(editor.agent, id, { title: 'Plan' });
    const audit = async () =>
      (await node.admin().get(`/v1/access/audit?targetId=${id}`).expect(200))
        .body.items.length as number;
    const entries = await audit();
    const same = await editor.agent
      .post(`/v1/test-items/${id}/revisions/2/restore`)
      .expect(200);
    expect(same.body).toMatchObject({ title: 'Plan', body: 'v1' });
    expect((await revisions(editor.agent, id)).items).toHaveLength(2);
    expect(await audit()).toBe(entries);
  });

  it('applies field-level permissions to snapshots, changes, diffs and restores', async () => {
    const role = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `Titles ${Date.now()}`,
        permissions: [
          { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
          { subject: 'TestItem', action: 'create', conditions: [] },
          {
            subject: 'TestItem',
            action: 'update',
            conditions: [{ key: 'mine' }],
            fields: [],
          },
        ],
      })
      .expect(201);
    const limited = await node.user([role.body.id]);
    const id = await writeItem(limited.agent, 'Mine', 'x');
    await patch(node.admin(), id, { title: 'Theirs', body: 'y' });
    await patch(node.admin(), id, { body: 'z' });

    const page = await revisions(limited.agent, id);
    expect(page.items.map((r) => r.number)).toEqual([3, 2, 1]);
    for (const revision of page.items) {
      expect(revision.snapshot).not.toHaveProperty('body');
    }
    expect(page.items[1]!.changes).toEqual({
      title: { from: 'Mine', to: 'Theirs' },
    });
    // A change only to the text: the revision shows, with nothing in it.
    expect(page.items[0]!.changes).toEqual({});
    const picked = await limited.agent
      .get(`/v1/test-items/${id}/revisions?fields=snapshot,changes`)
      .expect(200);
    expect(picked.body.items[1].snapshot).not.toHaveProperty('body');
    expect(picked.body.items[1].changes).not.toHaveProperty('body');
    expect(
      (await limited.agent.get(`/v1/test-items/${id}/revisions/1`).expect(200))
        .body.snapshot,
    ).not.toHaveProperty('body');
    expect(
      (
        await limited.agent
          .get(`/v1/test-items/${id}/revisions/1/diff/3`)
          .expect(200)
      ).body.changes,
    ).toEqual({ title: { from: 'Mine', to: 'Theirs' } });

    // Restoring 1 would set the text back: not theirs to change.
    const refused = await limited.agent
      .post(`/v1/test-items/${id}/revisions/1/restore`)
      .expect(403);
    expect(refused.body).toMatchObject({
      code: 'field_forbidden',
      fields: ['body'],
    });
    expect((await revisions(node.admin(), id)).items).toHaveLength(3);
  });

  it('keeps the first state of a test item written before revisions were kept', async () => {
    const editor = await node.user(['editor']);
    const db = node.db;
    const [old] = await db
      .insert(testItems)
      .values({
        tenantId: node.tenantId,
        ownerId: `user:${editor.id}`,
        title: 'Old',
        body: 'b',
      })
      .returning();
    expect((await revisions(editor.agent, old!.id)).items).toEqual([]);
    await patch(editor.agent, old!.id, { title: 'New' });

    const page = await revisions(editor.agent, old!.id);
    expect(page.items.map((r) => r.number)).toEqual([2, 1]);
    expect(page.items[1]).toMatchObject({
      snapshot: { title: 'Old', body: 'b' },
      changes: null,
      changedBy: 'unknown',
      changedByName: null,
    });
    expect(page.items[0]).toMatchObject({
      changes: { title: { from: 'Old', to: 'New' } },
      changedBy: `user:${editor.id}`,
    });
    const restored = await editor.agent
      .post(`/v1/test-items/${old!.id}/revisions/1/restore`)
      .expect(200);
    expect(restored.body.title).toBe('Old');
  });

  it('purging a test item removes its revisions, comments, tags and watchers', async () => {
    const editor = await node.user(['editor']);
    const db = node.db;
    const tag = await node
      .admin()
      .post('/v1/tags')
      .send({ subject: 'TestItem', name: 'Q3' })
      .expect(201);
    const write = async () => {
      const id = await writeItem(editor.agent);
      await patch(editor.agent, id, { title: 'Plan' });
      await editor.agent
        .post(`/v1/test-items/${id}/comments`)
        .send({ body: 'A comment' })
        .expect(201);
      await editor.agent
        .put(`/v1/test-items/${id}/tags`)
        .send({ tagIds: [tag.body.id] })
        .expect(200);
      return id;
    };
    const purged = await write();
    const kept = await write();
    const counts = async (id: string) => ({
      revisions: (
        await db
          .select()
          .from(revisionsTable)
          .where(eq(revisionsTable.recordId, id))
      ).length,
      comments: (
        await db.select().from(comments).where(eq(comments.recordId, id))
      ).length,
      tags: (
        await db.select().from(recordTags).where(eq(recordTags.recordId, id))
      ).length,
      watchers: (
        await db
          .select()
          .from(recordSubscriptions)
          .where(eq(recordSubscriptions.recordId, id))
      ).length,
    });
    expect(await counts(purged)).toEqual({
      revisions: 2,
      comments: 1,
      tags: 1,
      watchers: 1,
    });

    await editor.agent.delete(`/v1/test-items/${purged}`).expect(204);
    await db
      .update(testItems)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(testItems.id, purged));
    expect(await node.app.get(SoftDeletePurgeJob).run()).toMatchObject({
      TestItem: 1,
    });

    expect(await counts(purged)).toEqual({
      revisions: 0,
      comments: 0,
      tags: 0,
      watchers: 0,
    });
    expect(await counts(kept)).toEqual({
      revisions: 2,
      comments: 1,
      tags: 1,
      watchers: 1,
    });
  });

  it('keeps custom values in the snapshots and restores them', async () => {
    const field = await node
      .admin()
      .post('/v1/custom-fields')
      .send({
        subject: 'TestItem',
        key: 'region',
        label: 'Region',
        type: 'text',
      })
      .expect(201);
    const editor = await node.user(['editor']);
    const created = await node
      .writeItem(editor.agent, {
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
      .post(`/v1/test-items/${id}/revisions/1/restore`)
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
      (
        await editor.agent
          .get(`/v1/test-items/${id}/revisions/1/diff/2`)
          .expect(200)
      ).body.changes,
    ).toEqual({});
  });
});
