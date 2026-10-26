import { asc, sql } from 'drizzle-orm';
import { auditLog } from '../../../src/iam/iam.tables.js';
import { notes } from '../../../src/features/notes/notes.tables.js';
import { revisions } from '../../../src/platform/revisions/revisions.tables.js';
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

/** Holds the note's write lock until both requests have reached it. */
async function concurrentOnNoteLock<T>(
  node: TestApp,
  id: string,
  start: () => Promise<T>[],
) {
  let release!: () => void;
  let acquired!: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = node.inTenant(() =>
    node.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`approval-record:Note:${id}`}))`,
      );
      acquired();
      await held;
    }),
  );
  await lockAcquired;

  const requests = start();
  try {
    await vi.waitFor(async () => {
      const result = (await node.db.execute(
        sql`select count(*)::int as count from pg_locks where database = (select oid from pg_database where datname = current_database()) and locktype = 'advisory' and not granted`,
      )) as { rows: { count: number }[] };
      expect(Number(result.rows[0]!.count)).toBe(requests.length);
    });
  } finally {
    release();
  }
  await blocker;
  return Promise.all(requests);
}

describe('conditional note writes under concurrency (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });

  afterEach(async () => {
    await node.close();
  });

  it('allows only one concurrent update with the same ETag', async () => {
    const owner = await node.user(['editor']);
    const created = await writeNote(node, owner.agent).expect(201);
    const id = created.body.id as string;
    const original = await owner.agent.get(`/v1/notes/${id}`).expect(200);
    const etag = original.headers.etag as string;
    const responses = await concurrentOnNoteLock(node, id, () => [
      owner.agent
        .patch(`/v1/notes/${id}`)
        .set('If-Match', etag)
        .send({ title: 'First concurrent edit' })
        .then((response) => response),
      owner.agent
        .patch(`/v1/notes/${id}`)
        .set('If-Match', etag)
        .send({ title: 'Second concurrent edit' })
        .then((response) => response),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 412]);
    expect(
      responses.find((response) => response.status === 412)?.body.code,
    ).toBe('precondition_failed');

    const current = await owner.agent.get(`/v1/notes/${id}`).expect(200);
    expect(['First concurrent edit', 'Second concurrent edit']).toContain(
      current.body.title,
    );
    const [audit, history] = await node.inTenant(() =>
      Promise.all([
        node.db
          .select()
          .from(auditLog)
          .where(sql`${auditLog.targetId} = ${id}`),
        node.db
          .select()
          .from(revisions)
          .where(sql`${revisions.recordId} = ${id}`)
          .orderBy(asc(revisions.number)),
      ]),
    );
    expect(
      audit.filter((entry) => entry.action === 'note.updated'),
    ).toHaveLength(1);
    expect(history).toHaveLength(2);
    expect(history.at(-1)?.snapshot).toMatchObject({
      title: current.body.title,
    });
    expect(
      await node.inTenant(() =>
        node.db
          .select()
          .from(notes)
          .where(sql`${notes.id} = ${id}`),
      ),
    ).toHaveLength(1);
  });

  it('does not apply the same conditional delete twice', async () => {
    const owner = await node.user(['editor']);
    const created = await writeNote(node, owner.agent).expect(201);
    const id = created.body.id as string;
    const original = await owner.agent.get(`/v1/notes/${id}`).expect(200);
    const etag = original.headers.etag as string;
    const responses = await concurrentOnNoteLock(node, id, () => [
      owner.agent
        .delete(`/v1/notes/${id}`)
        .set('If-Match', etag)
        .then((response) => response),
      owner.agent
        .delete(`/v1/notes/${id}`)
        .set('If-Match', etag)
        .then((response) => response),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([204, 404]);
    const audit = await node.inTenant(() =>
      node.db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.targetId} = ${id}`),
    );
    expect(
      audit.filter((entry) => entry.action === 'note.deleted'),
    ).toHaveLength(1);
  });
});
