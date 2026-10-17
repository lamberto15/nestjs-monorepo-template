import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import type request from 'supertest';
import { bootApp, connect, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

describe('bulk operations on notes (e2e)', () => {
  let node: TestApp;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await node.close();
  });

  type Caller = string | request.Agent;
  const as = (auth: Caller, method: 'get' | 'post', path: string) =>
    typeof auth === 'string'
      ? node.http()[method](path).set('Authorization', auth)
      : auth[method](path);

  /** POST /v1/notes/bulk with a fresh Idempotency-Key (or this one). */
  const bulk = (
    auth: Caller,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    as(auth, 'post', '/v1/notes/bulk').set('Idempotency-Key', key).send(body);

  /** Writes notes with these titles; their ids. */
  async function write(auth: Caller, ...titles: string[]) {
    const ids: string[] = [];
    for (const title of titles) {
      ids.push(
        (await writeNote(node, auth, { title, body: 'b' }).expect(201)).body.id,
      );
    }
    return ids;
  }

  const titles = async (auth: Caller, query = '') =>
    (await as(auth, 'get', `/v1/notes${query}`).expect(200)).body.items
      .map((note: { title: string }) => note.title)
      .sort();

  /** Waits until the run is done, and returns its status. */
  async function finished(auth: Caller, id: string) {
    for (let tries = 0; tries < 100; tries++) {
      const status = await as(auth, 'get', `/v1/bulk/${id}`).expect(200);
      if (['completed', 'failed'].includes(status.body.status)) {
        return status.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The bulk run never finished');
  }

  it('deletes the ids the caller may delete, skips the rest, and audits each note and the run', async () => {
    const editor = await node.user(['editor']);
    const mine = await write(editor.agent, 'One', 'Two', 'Three', 'Kept');
    const other = await node.user(['editor']);
    const [theirs] = await write(other.agent, 'Theirs');
    const unknown = randomUUID();

    const ids = [mine[0], theirs, mine[1], unknown, mine[2], mine[0]];
    const res = await bulk(editor.agent, { action: 'delete', ids }).expect(200);
    expect(res.body).toEqual({
      done: 3,
      failed: 0,
      skipped: 2,
      // In the order asked for, once each.
      results: [
        { id: mine[0], status: 'done' },
        {
          id: theirs,
          status: 'skipped',
          error: { code: 'not_found', message: expect.any(String) },
        },
        { id: mine[1], status: 'done' },
        {
          id: unknown,
          status: 'skipped',
          error: { code: 'not_found', message: expect.any(String) },
        },
        { id: mine[2], status: 'done' },
      ],
    });
    expect(await titles(editor.agent)).toEqual(['Kept']);
    expect(await titles(other.agent)).toEqual(['Theirs']);

    const audit = await node
      .admin()
      .get(`/v1/access/audit?actor=user:${editor.id}&limit=100`)
      .expect(200);
    const actions = audit.body.items.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === 'note.deleted')).toHaveLength(3);
    expect(actions).toEqual(
      expect.arrayContaining(['bulk.started', 'bulk.finished']),
    );
    const done = audit.body.items.find(
      (e: { action: string }) => e.action === 'bulk.finished',
    );
    expect(done.details).toEqual({
      name: 'notes',
      action: 'delete',
      done: 3,
      failed: 0,
      skipped: 2,
    });

    // Back out of the recycle bin, the same way.
    const restored = await bulk(editor.agent, {
      action: 'restore',
      ids: mine.slice(0, 3),
    }).expect(200);
    expect(restored.body).toMatchObject({ done: 3, failed: 0, skipped: 0 });
    expect(await titles(editor.agent)).toEqual(['Kept', 'One', 'Three', 'Two']);
  });

  it('changes notes with the PATCH body, and fails each note whose field the caller may not set', async () => {
    const editor = await node.user(['editor']);
    const ids = await write(editor.agent, 'A', 'B');
    const changed = await bulk(editor.agent, {
      action: 'update',
      ids,
      input: { body: 'x' },
    }).expect(200);
    expect(changed.body).toMatchObject({ done: 2, failed: 0 });
    const note = await editor.agent.get(`/v1/notes/${ids[0]}`).expect(200);
    expect(note.body.body).toBe('x');

    const titlesOnly = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `Titles ${Date.now()}`,
        permissions: [
          { subject: 'Note', action: 'read', conditions: [{ key: 'mine' }] },
          { subject: 'Note', action: 'create', conditions: [] },
          {
            subject: 'Note',
            action: 'update',
            conditions: [{ key: 'mine' }],
            fields: [],
          },
        ],
      })
      .expect(201);
    const limited = await node.user([titlesOnly.body.id]);
    const own = await write(limited.agent, 'C', 'D');
    const refused = await bulk(limited.agent, {
      action: 'update',
      ids: own,
      input: { body: 'not allowed' },
    }).expect(200);
    expect(refused.body.done).toBe(0);
    expect(refused.body.failed).toBe(2);
    for (const item of refused.body.results) {
      expect(item).toMatchObject({
        status: 'failed',
        error: {
          code: 'field_forbidden',
          errors: [{ path: 'body', message: expect.any(String) }],
        },
      });
    }
    // The title, which the role may change, still goes through.
    await bulk(limited.agent, {
      action: 'update',
      ids: own,
      input: { title: 'Renamed' },
    })
      .expect(200)
      .expect(({ body }) => expect(body.done).toBe(2));
  });

  it('queues a filter selection, reports it to its starter only, and says so over realtime', async () => {
    const owner = await node.client();
    await write(owner.auth, 'Bulk one', 'Bulk two', 'Bulk three', 'Other');
    const socket = await connect(node, owner.key);
    sockets.push(socket);
    const heard = new Promise<Record<string, unknown>>((resolve) =>
      socket.once('bulk.finished', resolve),
    );

    const started = await bulk(owner.auth, {
      action: 'delete',
      filter: { 'title.startsWith': 'Bulk' },
    }).expect(202);
    expect(started.body).toEqual({ id: expect.any(String), status: 'queued' });

    const status = await finished(owner.auth, started.body.id);
    expect(status).toMatchObject({
      id: started.body.id,
      name: 'notes',
      action: 'delete',
      status: 'completed',
      progress: { processed: 3, done: 3, failed: 0 },
      result: { done: 3, failed: 0, skipped: 0 },
    });
    expect(status.result.results).toHaveLength(3);
    expect(await heard).toEqual({
      id: started.body.id,
      name: 'notes',
      action: 'delete',
      done: 3,
      failed: 0,
    });
    expect(await titles(owner.auth)).toEqual(['Other']);

    const stranger = await node.client();
    await as(stranger.auth, 'get', `/v1/bulk/${started.body.id}`).expect(404);
    await as(owner.auth, 'get', `/v1/bulk/${randomUUID()}`).expect(404);

    // A filter is checked before the job: a typo is a 400.
    const typo = await bulk(owner.auth, {
      action: 'delete',
      filter: { 'title.nope': 'x' },
    }).expect(400);
    expect(typo.body.code).toBe('validation_failed');
    expect(typo.body.errors[0].path).toMatch(/^filter/);
  });

  it('refuses invalid requests, and callers without the permission', async () => {
    const editor = await node.user(['editor']);
    const [id] = await write(editor.agent, 'Mine');

    const both = await bulk(editor.agent, {
      action: 'delete',
      ids: [id],
      filter: {},
    }).expect(400);
    expect(both.body.code).toBe('validation_failed');
    const neither = await bulk(editor.agent, { action: 'delete' }).expect(400);
    expect(neither.body.code).toBe('validation_failed');
    // A filter is conditions only: paging keys are refused, and so is none at all.
    const stray = await bulk(editor.agent, {
      action: 'delete',
      filter: { status: 'draft', limit: '10' },
    }).expect(400);
    expect(stray.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'filter.limit',
    ]);
    const empty = await bulk(editor.agent, {
      action: 'delete',
      filter: {},
    }).expect(400);
    expect(empty.body.errors.map((e: { path: string }) => e.path)).toEqual([
      'filter',
    ]);

    const many = Array.from({ length: 501 }, () => randomUUID());
    const tooMany = await bulk(editor.agent, {
      action: 'delete',
      ids: many,
    }).expect(400);
    expect(tooMany.body.code).toBe('bulk_too_many');

    const unknown = await bulk(editor.agent, {
      action: 'publish',
      ids: [id],
    }).expect(400);
    expect(unknown.body.code).toBe('validation_failed');
    expect(unknown.body.errors[0].path).toBe('action');

    const noInput = await bulk(editor.agent, {
      action: 'delete',
      ids: [id],
      input: { title: 'x' },
    }).expect(400);
    expect(noInput.body.errors[0].path).toBe('input');

    const viewer = await node.user(['viewer']);
    const forbidden = await bulk(viewer.agent, {
      action: 'delete',
      ids: [id],
    }).expect(403);
    expect(forbidden.body.code).toBe('forbidden');

    await editor.agent
      .post('/v1/notes/bulk')
      .send({ action: 'delete', ids: [id] })
      .expect(400);
    expect(await titles(editor.agent)).toEqual(['Mine']);
  });

  it('replays a retry with the same Idempotency-Key instead of acting twice', async () => {
    const editor = await node.user(['editor']);
    const ids = await write(editor.agent, 'Once');
    const key = randomUUID();
    const first = await bulk(
      editor.agent,
      { action: 'delete', ids },
      key,
    ).expect(200);
    expect(first.body.done).toBe(1);
    const retry = await bulk(
      editor.agent,
      { action: 'delete', ids },
      key,
    ).expect(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);

    // Without the key, a second run finds nothing left to delete.
    const again = await bulk(editor.agent, { action: 'delete', ids }).expect(
      200,
    );
    expect(again.body).toMatchObject({ done: 0, skipped: 1 });
  });
});
