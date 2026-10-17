import { randomUUID } from 'node:crypto';
import { OutboxRelay } from '@nestjs/outbox';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import { bootApp, type TestApp } from './support.js';

type Agent = ReturnType<TestApp['admin']>;
interface Comment {
  id: string;
  author: string;
  body: string;
  mentions: string[];
  editedAt: string | null;
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
      body: 'First!',
      mentions: [],
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

    // Who may not read the note sees none of it, nor writes.
    await outsider.agent.get(`/v1/test-items/${itemId}/comments`).expect(403);
    await outsider.agent
      .post(`/v1/test-items/${itemId}/comments`)
      .send({ body: 'Hi' })
      .expect(403);
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
      body: '[deleted]',
    });
    expect(after.find((c) => c.id === aboutAda.id)).toMatchObject({
      author: owner.key,
      body: 'Asking @[deleted] and @[deleted].',
      mentions: [],
    });
    expect(after.find((c) => c.id === aboutOtto.id)).toMatchObject({
      body: 'Ask @[deleted].',
    });
  });
});
