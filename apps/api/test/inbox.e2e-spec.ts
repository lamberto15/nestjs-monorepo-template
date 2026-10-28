import { OutboxRelay } from '@nestjs/outbox';
import type request from 'supertest';
import { approvalsHarness } from './approvals.support.js';

type Item = { key: string; kind: string; canDismiss: boolean; link: string };
type Page = { items: Item[]; nextCursor: string | null };

describe('the work inbox (e2e)', () => {
  const harness = approvalsHarness();
  const { publication, approve } = harness;

  const inbox = async (agent: request.Agent, query = '') =>
    (await agent.get(`/v1/inbox${query}`).expect(200)).body as Page;

  it('lists the approvals waiting on the user until they are decided, and nobody else sees them', async () => {
    const { node } = harness;
    const owner = await node.user(['editor']);
    const editor = await node.user(['editor']);
    const other = await node.otherTenant();
    const stranger = await other.user(['editor']);
    const { approval } = await publication(owner, editor);

    const waiting = await inbox(editor.agent);
    expect(waiting.items).toEqual([
      expect.objectContaining({
        key: `approval:${approval}`,
        kind: 'approval.decide',
        canDismiss: false,
        link: `/approvals/${approval}`,
      }),
    ]);
    // Not the owner's (never their own approver), nor another tenant's.
    expect((await inbox(owner.agent)).items).toEqual([]);
    expect((await inbox(stranger.agent)).items).toEqual([]);
    // An approval is done by deciding it, not dismissed.
    await editor.agent
      .post('/v1/inbox/dismiss')
      .send({ key: `approval:${approval}` })
      .expect(400);

    await approve(editor, approval).expect(200);
    expect((await inbox(editor.agent)).items).toEqual([]);
  });

  it('lists a mention of a record the user reads, dismisses it, and pages across sources', async () => {
    const { node } = harness;
    const owner = await node.user(['editor']);
    const editor = await node.user(['editor']);
    const colleague = await node.user(['editor']);
    const outsider = await node.user(['viewer']);
    const { testItem } = await publication(owner, editor);

    await owner.agent
      .post(`/v1/test-items/${testItem}/comments`)
      .send({ body: `@${editor.email} please look.` })
      .expect(201);
    await node.app.get(OutboxRelay).runOnce();

    const all = await inbox(editor.agent);
    expect(
      all.items.map((i) => i.kind).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['approval.decide', 'mention']);
    // One item a page: the cursor continues across both sources, each item once.
    const first = await inbox(editor.agent, '?limit=1');
    expect(first.nextCursor).not.toBeNull();
    const second = await inbox(
      editor.agent,
      `?limit=1&cursor=${first.nextCursor}`,
    );
    expect(
      [first.items[0]!.key, second.items[0]!.key].sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(all.items.map((i) => i.key).sort((a, b) => a.localeCompare(b)));
    expect(second.items).toHaveLength(1);
    expect((await inbox(editor.agent, '?source=mention')).items).toHaveLength(
      1,
    );
    await editor.agent.get('/v1/inbox?source=nope').expect(404);
    await editor.agent.get('/v1/inbox?cursor=!!').expect(400);

    // Not mentioned: nothing. Dismissing marks the mention read.
    expect((await inbox(colleague.agent)).items).toEqual([]);
    expect((await inbox(outsider.agent)).items).toEqual([]);
    const mention = all.items.find((i) => i.kind === 'mention')!;
    expect(mention.canDismiss).toBe(true);
    await colleague.agent
      .post('/v1/inbox/dismiss')
      .send({ key: mention.key })
      .expect(404);
    await editor.agent
      .post('/v1/inbox/dismiss')
      .send({ key: mention.key })
      .expect(204);
    expect((await inbox(editor.agent)).items.map((i) => i.kind)).toEqual([
      'approval.decide',
    ]);
  });
});
