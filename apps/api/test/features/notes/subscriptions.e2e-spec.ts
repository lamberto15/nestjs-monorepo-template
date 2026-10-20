import { SubscriptionsService } from '../../../src/platform/subscriptions/subscriptions.service.js';
import { OutboxRelay } from '@nestjs/outbox';
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

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
      await writeNote(node, editor.agent, { title: 'Draft', body: '' }).expect(
        201,
      )
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

  it('says whether the reader watches each note (?include=watching): one query for the page, theirs alone', async () => {
    const editor = await node.user(['editor']);
    const create = async (agent: ReturnType<TestApp['admin']>, title: string) =>
      (await writeNote(node, agent, { title, body: '' }).expect(201)).body as {
        id: string;
      };
    // Creators watch from the start: the editor's two are watched by the editor, not the administrator.
    const first = await create(editor.agent, 'First');
    const second = await create(editor.agent, 'Second');
    const mine = await create(node.admin(), 'Mine');
    const admin = node.admin();

    // Left out, there is no `watching`; asked for, it is the reader's own.
    const plain = await admin.get(`/v1/notes/${first.id}`).expect(200);
    expect(plain.body).not.toHaveProperty('watching');
    const detail = await admin
      .get(`/v1/notes/${first.id}?include=watching`)
      .expect(200);
    expect(detail.body.watching).toBe(false);
    // About the reader, not the record: the ETag stays the plain one.
    expect(detail.headers.etag).toBe(plain.headers.etag);
    expect(
      (
        await editor.agent
          .get(`/v1/notes/${first.id}?include=watching`)
          .expect(200)
      ).body.watching,
    ).toBe(true);
    expect(
      (await admin.get(`/v1/notes/${mine.id}?include=watching`).expect(200))
        .body.watching,
    ).toBe(true);

    // A list: each item marked, whatever `fields` picks, from one query on the page's ids.
    const watching = vi.spyOn(node.app.get(SubscriptionsService), 'watching');
    const page = await admin
      .get('/v1/notes?include=watching&fields=title&limit=10')
      .expect(200);
    const marks = Object.fromEntries(
      page.body.items.map((item: { id: string; watching: boolean }) => [
        item.id,
        item.watching,
      ]),
    );
    expect(marks).toEqual({
      [first.id]: false,
      [second.id]: false,
      [mine.id]: true,
    });
    expect(watching).toHaveBeenCalledTimes(1);
    expect(new Set(watching.mock.calls[0]![2])).toEqual(
      new Set([first.id, second.id, mine.id]),
    );
    // The editor's own subscriptions, beside `can`.
    const editorsPage = await editor.agent
      .get('/v1/notes?include=can,watching')
      .expect(200);
    expect(
      editorsPage.body.items.map(
        (item: { id: string; watching: boolean; can: object }) => [
          item.id,
          item.watching,
          typeof item.can,
        ],
      ),
    ).toEqual(
      expect.arrayContaining([
        [first.id, true, 'object'],
        [second.id, true, 'object'],
      ]),
    );
    expect(
      (await admin.get('/v1/notes').expect(200)).body.items[0],
    ).not.toHaveProperty('watching');

    // Watching and unwatching show at once.
    await admin.post(`/v1/notes/${first.id}/watch`).expect(200);
    expect(
      (await admin.get(`/v1/notes/${first.id}?include=watching`).expect(200))
        .body.watching,
    ).toBe(true);
    await admin.delete(`/v1/notes/${first.id}/watch`).expect(204);
    expect(
      (await admin.get(`/v1/notes/${first.id}?include=watching`).expect(200))
        .body.watching,
    ).toBe(false);
    await admin.get('/v1/notes?include=watchers').expect(400);
  });
});
