import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/core/database/drizzle.js';
import { notes } from '../src/features/notes/notes.tables.js';
import { SoftDeletePurgeJob } from '../src/iam/resources/soft-delete-purge.job.js';
import { bootApp, type TestApp } from './support.js';

/** Soft delete on notes: the recycle bin, restore, the purge. */
describe('soft delete (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  /** An API client with notes: its auth header and a request helper. */
  async function owner() {
    const { auth } = await node.client();
    const get = (path: string) =>
      node.http().get(path).set('Authorization', auth);
    const write = async (title: string) =>
      (await node.writeNote(auth, { title, body: 'x' }).expect(201)).body
        .id as string;
    return { auth, get, write };
  }

  it('hides a deleted note everywhere, keeps it in the bin, and restores it', async () => {
    const me = await owner();
    const kept = await me.write('Kept');
    const gone = await me.write('Gone');
    await node
      .http()
      .delete(`/v1/notes/${gone}`)
      .set('Authorization', me.auth)
      .expect(204);

    // Not in the list, nor its count, nor by id; deleting or changing it again: 404.
    const list = await me.get('/v1/notes?count=true').expect(200);
    expect(list.body.items.map((n: { id: string }) => n.id)).toEqual([kept]);
    expect(list.body.total).toBe(1);
    await me.get(`/v1/notes/${gone}`).expect(404);
    await node
      .http()
      .delete(`/v1/notes/${gone}`)
      .set('Authorization', me.auth)
      .expect(404);
    await node
      .http()
      .patch(`/v1/notes/${gone}`)
      .set('Authorization', me.auth)
      .send({ title: 'Back?' })
      .expect(404);
    // An OR filter can't reach it either.
    const anything = encodeURIComponent(
      JSON.stringify({
        or: [
          { field: 'title', op: 'contains', value: 'Gone' },
          { field: 'publishedAt', op: 'isNull', value: true }, // every draft
        ],
      }),
    );
    const filtered = await me.get(`/v1/notes?filter=${anything}`).expect(200);
    expect(filtered.body.items.map((n: { id: string }) => n.id)).toEqual([
      kept,
    ]);

    // The bin: only deleted notes, with who and when.
    const bin = await me.get('/v1/notes?deleted=true&count=true').expect(200);
    expect(bin.body.total).toBe(1);
    expect(bin.body.items[0]).toMatchObject({
      id: gone,
      deletedAt: expect.any(String),
      deletedBy: expect.stringMatching(/^client:/),
    });

    const restored = await node
      .http()
      .post(`/v1/notes/${gone}/restore`)
      .set('Authorization', me.auth)
      .expect(201);
    expect(restored.body).toMatchObject({ id: gone, deletedAt: null });
    await me.get(`/v1/notes/${gone}`).expect(200);
    // Restoring a live note: not in the bin.
    await node
      .http()
      .post(`/v1/notes/${gone}/restore`)
      .set('Authorization', me.auth)
      .expect(404);

    // Both audited.
    const audit = await node
      .admin()
      .get(`/v1/access/audit?targetId=${gone}&limit=10`)
      .expect(200);
    const actions = audit.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['note.deleted', 'note.restored']),
    );
  });

  it('shows the bin, and restores, only to those who may restore', async () => {
    const me = await owner();
    const id = await me.write('Mine');
    await node
      .http()
      .delete(`/v1/notes/${id}`)
      .set('Authorization', me.auth)
      .expect(204);
    // Another client: its own bin is empty, and it can't restore mine.
    const other = await owner();
    const theirs = await other.get('/v1/notes?deleted=true').expect(200);
    expect(theirs.body.items).toEqual([]);
    await node
      .http()
      .post(`/v1/notes/${id}/restore`)
      .set('Authorization', other.auth)
      .expect(403);
    // A viewer (read everything, no restore) sees no bin at all.
    const viewer = await node.user(['viewer']);
    const viewed = await viewer.agent.get('/v1/notes?deleted=true').expect(200);
    expect(viewed.body.items).toEqual([]);
    await viewer.agent.get(`/v1/notes/${id}`).expect(404);
  });

  it('purges what has been in the bin longer than the retention', async () => {
    const me = await owner();
    const old = await me.write('Old');
    const recent = await me.write('Recent');
    for (const id of [old, recent]) {
      await node
        .http()
        .delete(`/v1/notes/${id}`)
        .set('Authorization', me.auth)
        .expect(204);
    }
    const db = node.app.get<Database>(getDrizzleToken());
    await db
      .update(notes)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(notes.id, old));

    const purged = await node.app.get(SoftDeletePurgeJob).run();
    expect(purged).toEqual({ Note: 1 });
    const left = await db.select({ id: notes.id }).from(notes);
    expect(left.map((row) => row.id)).not.toContain(old);
    expect(left.map((row) => row.id)).toContain(recent);
    await node
      .http()
      .post(`/v1/notes/${old}/restore`)
      .set('Authorization', me.auth)
      .expect(404);
  });
});
