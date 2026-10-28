import { randomUUID } from 'node:crypto';
import { OutboxRelay } from '@nestjs/outbox';
import { eq } from 'drizzle-orm';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import { comments } from '../src/platform/comments/comments.tables.js';
import { recordSubscriptions } from '../src/platform/subscriptions/subscriptions.tables.js';
import { bootApp, connect, type TestApp } from './support.js';

type Agent = ReturnType<TestApp['admin']>;
interface Comment {
  id: string;
  author: string;
  authorName: string | null;
  body: string;
  mentions: string[];
  mentionNames: Record<string, string | null>;
  editedAt: string | null;
  parentId: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('comments and mentions on test items (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const deliver = () => node.app.get(OutboxRelay).runOnce();
  /** A user with these roles whose address and password the test knows, signed in. */
  async function person(roles: string[], name = 'Ada') {
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const token = await node.invite(node.admin(), {
      email,
      name,
      roleIds: await node.roleIds(...roles),
    });
    const password = await node.acceptAsNew(token);
    const agent = await node.signIn(email, password);
    const id = (await agent.get('/v1/auth/me').expect(200)).body.user
      .id as string;
    return { id, key: `user:${id}`, email, password, agent };
  }
  const writeItem = async (agent: Agent, title = 'Plan') =>
    (await node.writeItem(agent, { title, body: 'x' }).expect(201)).body
      .id as string;
  const comment = async (agent: Agent, itemId: string, body: string) =>
    (
      await agent
        .post(`/v1/test-items/${itemId}/comments`)
        .send({ body })
        .expect(201)
    ).body as Comment;
  const inbox = async (agent: Agent, type: string) =>
    (await agent.get(`/v1/notifications?type=${type}`).expect(200)).body
      .items as { body: string; link: string; data: Record<string, unknown> }[];

  it('adds, lists, edits and removes comments; the author edits, the author or a moderator removes', async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const itemId = await writeItem(owner.agent);

    const first = await comment(owner.agent, itemId, '  First!  ');
    expect(first).toMatchObject({
      subject: 'TestItem',
      recordId: itemId,
      author: owner.key,
      authorName: 'Owen',
      body: 'First!',
      mentions: [],
      mentionNames: {},
      editedAt: null,
    });
    const second = await comment(viewer.agent, itemId, 'Second');
    const third = await comment(owner.agent, itemId, 'Third');

    // Oldest first, cursor pages; newest first on request.
    const page1 = await viewer.agent
      .get(`/v1/test-items/${itemId}/comments?limit=2&count=true`)
      .expect(200);
    expect(page1.body.items.map((c: Comment) => c.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(page1.body.total).toBe(3);
    const page2 = await viewer.agent
      .get(
        `/v1/test-items/${itemId}/comments?limit=2&cursor=${page1.body.nextCursor}`,
      )
      .expect(200);
    expect(page2.body.items.map((c: Comment) => c.id)).toEqual([third.id]);
    expect(page2.body.nextCursor).toBeNull();
    const newest = await viewer.agent
      .get(`/v1/test-items/${itemId}/comments?sort=-createdAt&limit=2`)
      .expect(200);
    expect(newest.body.items.map((c: Comment) => c.id)).toEqual([
      third.id,
      second.id,
    ]);
    const rest = await viewer.agent
      .get(
        `/v1/test-items/${itemId}/comments?sort=-createdAt&limit=2&cursor=${encodeURIComponent(newest.body.nextCursor)}`,
      )
      .expect(200);
    expect(rest.body.items.map((c: Comment) => c.id)).toEqual([first.id]);
    const byViewer = await owner.agent
      .get(`/v1/test-items/${itemId}/comments?author=${viewer.key}&fields=body`)
      .expect(200);
    expect(byViewer.body.items).toEqual([{ id: second.id, body: 'Second' }]);
    // Each author by name, for every reader (GET /v1/people's names).
    expect(
      page1.body.items.map((c: Comment) => [c.author, c.authorName]),
    ).toEqual([
      [owner.key, 'Owen'],
      [viewer.key, 'Vera'],
    ]);

    // Who may not read the note sees none of it, nor writes: as if it didn't exist.
    await outsider.agent.get(`/v1/test-items/${itemId}/comments`).expect(404);
    await outsider.agent
      .post(`/v1/test-items/${itemId}/comments`)
      .send({ body: 'Hi' })
      .expect(404);
    await owner.agent
      .get(`/v1/test-items/${randomUUID()}/comments`)
      .expect(404);

    // Validation: empty, too long.
    for (const body of ['   ', 'x'.repeat(10_001)]) {
      const refused = await owner.agent
        .post(`/v1/test-items/${itemId}/comments`)
        .send({ body })
        .expect(400);
      expect(refused.body.code).toBe('validation_failed');
    }
    await owner.agent
      .post(`/v1/test-items/${itemId}/comments`)
      .send({ body: 'x'.repeat(10_000) })
      .expect(201);

    // Only the author edits.
    const edited = await owner.agent
      .patch(`/v1/test-items/${itemId}/comments/${first.id}`)
      .send({ body: 'First, edited' })
      .expect(200);
    expect(edited.body).toMatchObject({ body: 'First, edited' });
    expect(edited.body.editedAt).not.toBeNull();
    await viewer.agent
      .patch(`/v1/test-items/${itemId}/comments/${first.id}`)
      .send({ body: 'Hijacked' })
      .expect(403);
    await owner.agent
      .patch(`/v1/test-items/${itemId}/comments/${randomUUID()}`)
      .send({ body: 'Nope' })
      .expect(404);

    // The viewer (no TestItem.update) can't remove the owner's; the owner (a moderator) removes the viewer's.
    await viewer.agent
      .delete(`/v1/test-items/${itemId}/comments/${third.id}`)
      .expect(403);
    await owner.agent
      .delete(`/v1/test-items/${itemId}/comments/${second.id}`)
      .expect(204);
    await owner.agent
      .delete(`/v1/test-items/${itemId}/comments/${second.id}`)
      .expect(404);
    // The author removes their own.
    await owner.agent
      .delete(`/v1/test-items/${itemId}/comments/${third.id}`)
      .expect(204);
    const left = await owner.agent
      .get(`/v1/test-items/${itemId}/comments`)
      .expect(200);
    expect(left.body.items.map((c: Comment) => c.id)).toEqual([
      first.id,
      expect.any(String),
    ]);

    // Audited, the comment as target, the note in the details.
    for (const [action, id] of [
      ['comment.added', first.id],
      ['comment.edited', first.id],
      ['comment.removed', second.id],
    ]) {
      const audit = await node
        .admin()
        .get(`/v1/access/audit?action=${action}&limit=100`)
        .expect(200);
      expect(
        audit.body.items.find((e: { targetId: string }) => e.targetId === id),
      ).toMatchObject({
        targetType: 'comment',
        details: expect.objectContaining({
          subject: 'TestItem',
          recordId: itemId,
        }),
      });
    }
  });

  it('threads: one level of replies, resolve and reopen by the author or a moderator, filters, a thread removed with its replies', async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const itemId = await writeItem(owner.agent, 'Roadmap');
    const base = `/v1/test-items/${itemId}/comments`;
    const reply = (agent: Agent, parentId: string, body: string) =>
      agent.post(base).send({ body, parentId });

    const thread = await comment(viewer.agent, itemId, 'Is this final?');
    const other = await comment(viewer.agent, itemId, 'Another question');
    expect(thread).toMatchObject({ parentId: null, resolvedAt: null });
    const answer = (await reply(owner.agent, thread.id, 'Yes.').expect(201))
      .body as Comment & { parentId: string };
    expect(answer.parentId).toBe(thread.id);

    // Depth is one: no reply to a reply; the parent must be a comment of this record.
    await reply(owner.agent, answer.id, 'Nested').expect(400);
    await reply(owner.agent, randomUUID(), 'Nobody').expect(404);
    await reply(outsider.agent, thread.id, 'Hi').expect(404);

    // The thread's author is told of the reply, once; not the replier.
    await deliver();
    expect(await inbox(viewer.agent, 'comment.replied')).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('Owen replied to your comment'),
      }),
    ]);
    expect(await inbox(viewer.agent, 'testItem.commented')).toEqual([]);
    expect(await inbox(owner.agent, 'comment.replied')).toEqual([]);

    // Filters: the threads, one thread's replies, the open ones.
    const ids = async (query: string) =>
      (
        (await viewer.agent.get(`${base}?${query}`).expect(200)).body
          .items as Comment[]
      ).map((c) => c.id);
    expect(await ids('')).toEqual([thread.id, other.id, answer.id]);
    expect(await ids('parentId.isNull=true')).toEqual([thread.id, other.id]);
    expect(await ids(`parentId=${thread.id}`)).toEqual([answer.id]);

    // Resolving: the thread's author or a moderator, not another reader; repeating changes nothing.
    await reply(viewer.agent, thread.id, 'Mine too').expect(201);
    await outsider.agent.post(`${base}/${thread.id}/resolve`).expect(404);
    await owner.agent.post(`${base}/${answer.id}/resolve`).expect(400);
    const resolved = await viewer.agent
      .post(`${base}/${thread.id}/resolve`)
      .expect(200);
    expect(resolved.body).toMatchObject({
      resolvedBy: viewer.key,
      resolvedAt: expect.any(String),
    });
    await viewer.agent.post(`${base}/${thread.id}/resolve`).expect(200);
    expect(await ids('resolvedAt.isNull=true&parentId.isNull=true')).toEqual([
      other.id,
    ]);
    // A resolved thread takes no reply until reopened.
    await reply(owner.agent, thread.id, 'Late').expect(409);
    await viewer.agent.post(`${base}/${other.id}/resolve`).expect(200);
    // A reader who isn't the author nor a moderator may not reopen it; the owner (a moderator) may.
    const reader = await person(['viewer'], 'Rhea');
    await reader.agent.post(`${base}/${thread.id}/reopen`).expect(403);
    const reopened = await owner.agent
      .post(`${base}/${thread.id}/reopen`)
      .expect(200);
    expect(reopened.body).toMatchObject({ resolvedAt: null, resolvedBy: null });
    await reply(owner.agent, thread.id, 'Now yes').expect(201);

    // Removing the thread removes its replies, audited with their number.
    await owner.agent.delete(`${base}/${thread.id}`).expect(204);
    expect(await ids('')).toEqual([other.id]);
    const audit = await node
      .admin()
      .get('/v1/access/audit?action=comment.removed&limit=100')
      .expect(200);
    expect(
      audit.body.items.find(
        (e: { targetId: string }) => e.targetId === thread.id,
      ).details,
    ).toMatchObject({ replies: 3 });
    for (const action of ['comment.resolved', 'comment.reopened']) {
      const entries = await node
        .admin()
        .get(`/v1/access/audit?action=${action}&limit=100`)
        .expect(200);
      expect(entries.body.items).not.toHaveLength(0);
    }
  });

  it('tells those mentioned who may read the note, and its watchers; the author watches from their first comment', async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const colleague = await person(['viewer'], 'Cleo');
    const itemId = await writeItem(owner.agent, 'Budget');

    // The viewer mentions the colleague (by address), the outsider (who can't read the note) and nobody real.
    const mentioning = await comment(
      viewer.agent,
      itemId,
      `@${colleague.email.toUpperCase()}, @${outsider.email} and @nobody@example.com: please check.`,
    );
    expect(mentioning.mentions).toEqual([colleague.key]);
    // Named by the address too (lower-cased); the outsider's and the unknown one's get none.
    expect(mentioning.mentionNames).toEqual({
      [colleague.key]: 'Cleo',
      [colleague.email.toLowerCase()]: 'Cleo',
    });
    await deliver();

    const mentioned = await inbox(colleague.agent, 'comment.mentioned');
    expect(mentioned).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('Vera mentioned you on "Budget"'),
        link: `/test-items/${itemId}`,
        data: expect.objectContaining({
          subject: 'TestItem',
          recordId: itemId,
          commentId: mentioning.id,
        }),
      }),
    ]);
    await node.waitForMail({ to: colleague.email, subject: /mentioned/ });
    expect(await inbox(outsider.agent, 'comment.mentioned')).toEqual([]);
    // Mentioned, not told twice; the colleague doesn't watch the note.
    expect(await inbox(colleague.agent, 'testItem.commented')).toEqual([]);

    // The owner watches their note: told of the comment; the author isn't.
    expect(await inbox(owner.agent, 'testItem.commented')).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('Vera commented on "Budget"'),
        link: `/test-items/${itemId}`,
      }),
    ]);
    expect(await inbox(viewer.agent, 'testItem.commented')).toEqual([]);

    // The author now watches the note: the owner's answer reaches them, not the owner.
    const watching = await viewer.agent.get('/v1/subscriptions').expect(200);
    expect(watching.body.items).toEqual([
      expect.objectContaining({ subject: 'TestItem', recordId: itemId }),
    ]);
    await comment(owner.agent, itemId, 'Thanks!');
    await deliver();
    expect(await inbox(viewer.agent, 'testItem.commented')).toHaveLength(1);
    expect(await inbox(owner.agent, 'testItem.commented')).toHaveLength(1);

    // Having stopped watching, a later comment of theirs doesn't make them watch again.
    await viewer.agent.delete(`/v1/test-items/${itemId}/watch`).expect(204);
    await comment(viewer.agent, itemId, 'Again');
    expect(
      (await viewer.agent.get('/v1/subscriptions').expect(200)).body.items,
    ).toEqual([]);

    // Mentioned by `@user:<id>` in an edit: told then, once.
    const plain = await comment(owner.agent, itemId, 'Later');
    await owner.agent
      .patch(`/v1/test-items/${itemId}/comments/${plain.id}`)
      .send({ body: `Later, @user:${colleague.id}` })
      .expect(200);
    await owner.agent
      .patch(`/v1/test-items/${itemId}/comments/${plain.id}`)
      .send({ body: `Later still, @user:${colleague.id}` })
      .expect(200);
    await deliver();
    expect(await inbox(colleague.agent, 'comment.mentioned')).toHaveLength(2);
  });

  it("exports a person's comments with their data; their account's deletion anonymizes them", async () => {
    const owner = await person(['editor'], 'Owen');
    const ada = await person(['viewer'], 'Ada');
    const itemId = await writeItem(owner.agent);
    const mine = await comment(ada.agent, itemId, 'Written by Ada');
    const aboutAda = await comment(
      owner.agent,
      itemId,
      `Asking @${ada.email} and @user:${ada.id}.`,
    );
    expect(aboutAda.mentions).toEqual([ada.key]);
    // Otto can't read Owen's draft: the mention is dropped, the address stays in the text.
    const otto = await person(['editor'], 'Otto');
    const aboutOtto = await comment(owner.agent, itemId, `Ask @${otto.email}.`);
    expect(aboutOtto.mentions).toEqual([]);
    // Someone else's note is not this one: 404.
    const otherItemId = await writeItem(owner.agent);
    await ada.agent
      .patch(`/v1/test-items/${otherItemId}/comments/${mine.id}`)
      .send({ body: 'Moved?' })
      .expect(404);

    const started = await ada.agent
      .post('/v1/account/export')
      .send({})
      .expect(202);
    let status;
    for (let tries = 0; tries < 100; tries++) {
      status = (
        await ada.agent.get(`/v1/data/transfers/${started.body.id}`).expect(200)
      ).body;
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    const file = (await node.http().get(local(status.result.url)).expect(200))
      .body as { kind: string; id: string; data: Record<string, unknown> }[];
    expect(file.filter((row) => row.kind === 'comments')).toEqual([
      expect.objectContaining({
        id: mine.id,
        data: expect.objectContaining({ body: 'Written by Ada' }),
      }),
    ]);

    await ada.agent
      .post('/v1/account/deletion')
      .send({ password: ada.password })
      .expect(200);
    await otto.agent
      .post('/v1/account/deletion')
      .send({ password: otto.password })
      .expect(200);
    const job = node.app.get(AccountDeletionJob);
    expect(await job.run(new Date(Date.now() + 15 * 86_400_000))).toBe(2);

    const after = (
      await owner.agent.get(`/v1/test-items/${itemId}/comments`).expect(200)
    ).body.items as Comment[];
    expect(after.find((c) => c.id === mine.id)).toMatchObject({
      author: 'anonymous',
      authorName: null,
      body: '[deleted]',
    });
    expect(after.find((c) => c.id === aboutAda.id)).toMatchObject({
      author: owner.key,
      body: 'Asking @[deleted] and @[deleted].',
      mentions: [],
      mentionNames: {},
    });
    expect(after.find((c) => c.id === aboutOtto.id)).toMatchObject({
      body: 'Ask @[deleted].',
    });
  });

  it("names the people a comment mentions, in one page's query: a member who left keeps their name, another tenant's people have none", async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const colleague = await person(['viewer'], 'Cleo');
    const itemId = await writeItem(owner.agent);
    const other = await node.otherTenant();
    const theirs = await other.user(['viewer']);
    const theirKey = `user:${theirs.id}`;

    const both = await comment(
      owner.agent,
      itemId,
      `@user:${viewer.id} and @${colleague.email}, with @user:${theirs.id} and @${theirs.email}`,
    );
    // Another tenant's person is nobody here: not mentioned, not named.
    expect(both.mentions).toEqual([viewer.key, colleague.key]);
    expect(both.mentionNames).toEqual({
      [viewer.key]: 'Vera',
      [colleague.key]: 'Cleo',
      [colleague.email.toLowerCase()]: 'Cleo',
    });
    const one = await comment(viewer.agent, itemId, `@user:${colleague.id}`);
    expect(one.mentionNames).toEqual({ [colleague.key]: 'Cleo' });

    // An edit answers with the names of what it now mentions.
    const edited = await owner.agent
      .patch(`/v1/test-items/${itemId}/comments/${both.id}`)
      .send({ body: `Only @user:${viewer.id}` })
      .expect(200);
    expect(edited.body.mentionNames).toEqual({ [viewer.key]: 'Vera' });

    // The list names them for every reader; `fields=` picks them.
    const listed = await colleague.agent
      .get(`/v1/test-items/${itemId}/comments`)
      .expect(200);
    expect((listed.body.items as Comment[]).map((c) => c.mentionNames)).toEqual(
      [{ [viewer.key]: 'Vera' }, { [colleague.key]: 'Cleo' }],
    );
    const picked = await colleague.agent
      .get(`/v1/test-items/${itemId}/comments?fields=mentions,mentionNames`)
      .expect(200);
    expect(picked.body.items[0]).toEqual({
      id: both.id,
      mentions: [viewer.key],
      mentionNames: { [viewer.key]: 'Vera' },
    });

    // A member who left the tenant keeps their name on what mentions them, as an author does.
    await node
      .admin()
      .patch(`/v1/access/users/${viewer.id}`)
      .send({ active: false })
      .expect(204);
    // A key of another tenant's person (stored before they were a member
    // elsewhere, say) never shows their name here.
    await node.db
      .update(comments)
      .set({ mentions: [colleague.key, theirKey] })
      .where(eq(comments.id, one.id));
    const later = (
      await owner.agent.get(`/v1/test-items/${itemId}/comments`).expect(200)
    ).body.items as Comment[];
    expect(later.map((c) => c.mentionNames)).toEqual([
      { [viewer.key]: 'Vera' },
      { [colleague.key]: 'Cleo', [theirKey]: null },
    ]);
    // Their tenant's comments name its own people, never ours.
    const theirItem = await writeItem(other.admin);
    const theirs1 = await comment(
      other.admin,
      theirItem,
      `@user:${theirs.id} and @user:${colleague.id}`,
    );
    expect(theirs1.mentionNames).toEqual({ [theirKey]: theirs.email });
  });

  it('names a mention written as an address under that address too (lower-cased), and an address that mentioned nobody not at all', async () => {
    const owner = await person(['editor'], 'Owen');
    const colleague = await person(['viewer'], 'Cleo');
    // Cannot read the owner's note: the mention drops them, so their address gets no name.
    const outsider = await person(['editor'], 'Otto');
    const itemId = await writeItem(owner.agent);
    const address = colleague.email.toLowerCase();

    const mixed = await comment(
      owner.agent,
      itemId,
      `Hi @${colleague.email.toUpperCase()}, not @${outsider.email} or @nobody@example.com; plain ${outsider.email} too.`,
    );
    expect(mixed.mentions).toEqual([colleague.key]);
    expect(mixed.mentionNames).toEqual({
      [colleague.key]: 'Cleo',
      [address]: 'Cleo',
    });
    expect(mixed.mentionNames).not.toHaveProperty(outsider.email);
    expect(mixed.mentionNames).not.toHaveProperty('nobody@example.com');

    // Mentioned by key: no address entry, whatever the text says.
    const byKey = await comment(
      owner.agent,
      itemId,
      `@user:${colleague.id} and ${colleague.email}`,
    );
    expect(byKey.mentionNames).toEqual({ [colleague.key]: 'Cleo' });

    // The list names it for every reader, and an edit answers with it.
    const listed = (
      await colleague.agent.get(`/v1/test-items/${itemId}/comments`).expect(200)
    ).body.items as Comment[];
    expect(listed.map((c) => c.mentionNames)).toEqual([
      { [colleague.key]: 'Cleo', [address]: 'Cleo' },
      { [colleague.key]: 'Cleo' },
    ]);
    const edited = await owner.agent
      .patch(`/v1/test-items/${itemId}/comments/${byKey.id}`)
      .send({ body: `Now @${colleague.email}` })
      .expect(200);
    expect(edited.body.mentionNames).toEqual({
      [colleague.key]: 'Cleo',
      [address]: 'Cleo',
    });
  });

  it('mentions an address with dots in its local part (`@first.last@sub.example.com`)', async () => {
    const owner = await person(['editor'], 'Owen');
    const email = `maya.patel.${randomUUID().slice(0, 6)}@demo.example.com`;
    const name = `Maya ${randomUUID().slice(0, 6)}`;
    const token = await node.invite(node.admin(), {
      email,
      name,
      roleIds: await node.roleIds('viewer'),
    });
    await node.acceptAsNew(token);
    const [maya] = (
      await node
        .admin()
        .get(`/v1/people?q=${encodeURIComponent(name)}`)
        .expect(200)
    ).body.items as { key: string }[];
    const itemId = await writeItem(owner.agent);
    const mentioning = await comment(
      owner.agent,
      itemId,
      `Hi @${email}, have a look.`,
    );
    expect(mentioning.mentions).toEqual([maya!.key]);
  });

  it("tells the record's open pages of its comments over realtime: those who may read it, never the content", async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const itemId = await writeItem(owner.agent);
    const tokenOf = async (who: { email: string; password: string }) =>
      (
        await node
          .http()
          .post('/v1/auth/token')
          .send({ email: who.email, password: who.password })
          .expect(200)
      ).body.accessToken as string;
    // The outsider watches the item but may not read it: nothing reaches them.
    await node.db.insert(recordSubscriptions).values({
      tenantId: node.tenantId,
      subject: 'TestItem',
      recordId: itemId,
      subscriber: outsider.key,
    });
    const sockets = await Promise.all(
      [owner, outsider].map(async (who) => connect(node, await tokenOf(who))),
    );
    const heard: Record<string, unknown>[][] = [[], []];
    sockets.forEach((socket, index) =>
      socket.on('record.commented', (data: Record<string, unknown>) =>
        heard[index]!.push(data),
      ),
    );
    try {
      // The owner watches their item (its creator): told of the viewer's comments.
      // The service pushes without awaiting (permission checks run after the
      // answer), so the events can lag the response and reorder if actions
      // overlap: wait for each one before the next action, never a fixed delay.
      const heardCount = (count: number) =>
        vi.waitFor(() => expect(heard[0]).toHaveLength(count), {
          timeout: 5000,
        });
      const added = await comment(viewer.agent, itemId, 'A thought');
      await heardCount(1);
      await viewer.agent
        .patch(`/v1/test-items/${itemId}/comments/${added.id}`)
        .send({ body: 'A better thought' })
        .expect(200);
      await heardCount(2);
      await viewer.agent
        .delete(`/v1/test-items/${itemId}/comments/${added.id}`)
        .expect(204);
      await heardCount(3);
      expect(heard[0]).toEqual(
        ['added', 'edited', 'removed'].map((action) => ({
          subject: 'TestItem',
          recordId: itemId,
          commentId: added.id,
          action,
        })),
      );
      expect(heard[1]).toEqual([]);
    } finally {
      sockets.forEach((socket) => socket.disconnect());
    }
  });
});
