import { approvalWorkflowId } from '../src/platform/approvals/approval-events.js';
import { RecordPurgeRegistry } from '../src/iam/resources/record-purge.registry.js';
import { type TestApp } from './support.js';
import { approvalsHarness, type User } from './approvals.support.js';

describe('approvals (e2e)', () => {
  const harness = approvalsHarness();
  const {
    requestApproval,
    setPolicy,
    stage,
    users,
    aTestItem,
    ask,
    detail,
    types,
    approve,
    publication,
  } = harness;
  let node: TestApp;

  beforeEach(() => {
    node = harness.node;
  });

  describe('publishing a test item, end to end', () => {
    it('asks an editor before publishing, refuses edits meanwhile, publishes once approved', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const created = await node.writeItem(owner.agent).expect(201);
      const asked = await owner.agent
        .post(`/v1/test-items/${created.body.id}/publish`)
        .expect(200);
      expect(asked.body).toMatchObject({ published: false });
      await node.worker.drain(); // the approval assigns the editors

      const inbox = await editor.agent
        .get('/v1/approvals?assignedToMe=true')
        .expect(200);
      expect(inbox.body.items).toHaveLength(1);
      const [item] = inbox.body.items;
      expect(item.id).toBe(asked.body.approvalId);
      expect(item).toMatchObject({
        key: 'TestItem.publish',
        recordId: created.body.id,
        status: 'pending',
        title: 'Hello',
        payload: { title: 'Hello' },
        requester: `user:${owner.id}`,
        stageName: 'Editor review',
      });
      // The owner is never their own approver, though an editor too.
      expect(
        (await owner.agent.get('/v1/approvals?assignedToMe=true').expect(200))
          .body.items,
      ).toHaveLength(0);
      expect(
        (await owner.agent.get('/v1/approvals?requestedByMe=true').expect(200))
          .body.items,
      ).toHaveLength(1);

      // While the editors decide, the test item doesn't change.
      const refused = await owner.agent
        .patch(`/v1/test-items/${created.body.id}`)
        .send({ title: 'Changed' })
        .expect(409);
      expect(refused.body).toMatchObject({
        code: 'approval_pending',
        approvalId: item.id,
      });
      await owner.agent.delete(`/v1/test-items/${created.body.id}`).expect(409);

      await approve(editor, item.id, { comment: 'Fine.' }).expect(200);
      await node.worker.drain(); // the outcome's handler publishes
      const published = await owner.agent
        .get(`/v1/test-items/${created.body.id}`)
        .expect(200);
      expect(published.body.publishedAt).toEqual(expect.any(String));
      const done = await detail(owner.agent, item.id);
      expect(done).toMatchObject({ status: 'approved', outcomeReason: null });
      expect(
        done.timeline.map((event: { type: string }) => event.type),
      ).toEqual(['requested', 'stage_started', 'decided', 'approved']);
      expect(await types(owner.agent)).toContain('approval.approved');
      expect(await types(editor.agent)).toContain('approval.requested');
    });

    it('needs no approval while testItems.publishApproval is off: the test item publishes at once', async () => {
      await node
        .admin()
        .put('/v1/settings/testItems.publishApproval')
        .send({ value: false })
        .expect(200);
      const owner = await node.user(['editor']);
      await node.user(['editor']);
      const created = await node.writeItem(owner.agent).expect(201);
      const asked = await owner.agent
        .post(`/v1/test-items/${created.body.id}/publish`)
        .expect(200);
      expect(asked.body).toEqual({ published: true, approvalId: null });
      expect(
        (await owner.agent.get(`/v1/test-items/${created.body.id}`).expect(200))
          .body.publishedAt,
      ).toEqual(expect.any(String));
      const result = await requestApproval(`user:${owner.id}`, {
        subject: 'TestItem',
        recordId: created.body.id,
        action: 'publish',
      });
      expect(result).toEqual({ required: false });
    });
  });

  describe('stages and modes', () => {
    it('any: the first decision decides; the stage’s other approvers are closed out', async () => {
      const [requester, a, b] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({ stages: [stage([users(a, b)])] });
      const id = await ask(requester);
      await approve(a, id).expect(200);
      const shown = await detail(requester.agent, id);
      expect(shown.status).toBe('approved');
      expect(
        shown.assignments.map((x: { approverId: string; status: string }) => [
          x.approverId,
          x.status,
        ]),
      ).toEqual([
        [a.id, 'approved'],
        [b.id, 'closed'],
      ]);
      const late = await approve(b, id).expect(409);
      expect(late.body.code).toBe('approval_closed');
    });

    it('all: every approver must approve', async () => {
      const [requester, a, b] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [stage([users(a, b)], { mode: { type: 'all' } })],
      });
      const id = await ask(requester);
      await approve(a, id).expect(200);
      expect((await detail(requester.agent, id)).status).toBe('pending');
      // The same decision again changes nothing; another one is refused.
      await approve(a, id).expect(200);
      const otherwise = await a.agent
        .post(`/v1/approvals/${id}/reject`)
        .send({ comment: 'No.' })
        .expect(409);
      expect(otherwise.body.code).toBe('approval_already_decided');
      await approve(b, id).expect(200);
      expect((await detail(requester.agent, id)).status).toBe('approved');
      await node.worker.drain();
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(id)))?.status,
      ).toBe('completed');
    });

    it('quorum: n approvals of the stage', async () => {
      const [requester, a, b, c] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [stage([users(a, b, c)], { mode: { type: 'quorum', n: 2 } })],
      });
      const id = await ask(requester);
      await approve(a, id).expect(200);
      await b.agent
        .post(`/v1/approvals/${id}/reject`)
        .send({ comment: 'Not yet.' })
        .expect(200);
      expect((await detail(requester.agent, id)).status).toBe('pending');
      await approve(c, id).expect(200);
      expect((await detail(requester.agent, id)).status).toBe('approved');
    });

    it('multi-stage: the next stage starts once one is approved', async () => {
      const [requester, lead, director] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [
          { name: 'Lead', approvers: [users(lead)] },
          { name: 'Director', approvers: [users(director)] },
        ],
      });
      const id = await ask(requester);
      // Stage 2's approver takes no part in stage 1: it's hidden from them.
      await approve(director, id).expect(404);
      await approve(lead, id).expect(200);
      expect(await detail(requester.agent, id)).toMatchObject({
        status: 'pending',
        currentStage: 0,
        stages: [{ state: 'approved' }, { state: 'waiting' }],
      });
      await node.worker.drain(); // the workflow starts stage 2
      const second = await detail(director.agent, id);
      expect(second).toMatchObject({
        currentStage: 1,
        stageName: 'Director',
        stages: [{ state: 'approved' }, { state: 'active' }],
        can: { decide: true },
      });
      await approve(director, id).expect(200);
      expect((await detail(requester.agent, id)).status).toBe('approved');
    });

    it('reject: a comment says why, the requester is told', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      const bare = await a.agent
        .post(`/v1/approvals/${id}/reject`)
        .send({})
        .expect(400);
      expect(bare.body.code).toBe('validation_failed');
      await a.agent
        .post(`/v1/approvals/${id}/reject`)
        .send({ comment: 'Too vague.' })
        .expect(200);
      expect((await detail(requester.agent, id)).status).toBe('rejected');
      const told = (
        await requester.agent.get('/v1/notifications').expect(200)
      ).body.items.find(
        (n: { type: string }) => n.type === 'approval.rejected',
      );
      expect(told.body).toContain('Too vague.');
    });

    it('request changes, then resubmit: a new round from the first stage', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      await a.agent
        .post(`/v1/approvals/${id}/request-changes`)
        .send({ comment: 'Add the totals.' })
        .expect(200);
      expect((await detail(requester.agent, id)).status).toBe(
        'changes_requested',
      );
      expect(await types(requester.agent)).toContain(
        'approval.changesRequested',
      );
      // Only the requester resubmits; the payload is read from the testItem, never sent.
      await a.agent.post(`/v1/approvals/${id}/resubmit`).send({}).expect(403);
      const sent = await requester.agent
        .post(`/v1/approvals/${id}/resubmit`)
        .send({ payload: { title: 'Something else' } })
        .expect(400);
      expect(sent.body.errors[0].path).toBe('payload');
      // Sent back, the testItem may change: the new round proposes what it holds now.
      const { recordId } = await detail(requester.agent, id);
      await node
        .admin()
        .patch(`/v1/test-items/${recordId}`)
        .send({ title: 'Q3 report, with totals' })
        .expect(200);
      const again = await requester.agent
        .post(`/v1/approvals/${id}/resubmit`)
        .send({ comment: 'Done.' })
        .expect(200);
      expect(again.body).toMatchObject({
        status: 'pending',
        round: 1,
        title: 'Q3 report, with totals',
      });
      await node.worker.drain(); // round 1's first stage
      await approve(a, id).expect(200);
      const shown = await detail(requester.agent, id);
      expect(shown.status).toBe('approved');
      expect(
        shown.assignments.map((x: { round: number; status: string }) => [
          x.round,
          x.status,
        ]),
      ).toEqual([
        [0, 'changes_requested'],
        [1, 'approved'],
      ]);
      // A resubmission of an approved request is refused.
      expect(
        (
          await requester.agent
            .post(`/v1/approvals/${id}/resubmit`)
            .send({})
            .expect(409)
        ).body.code,
      ).toBe('approval_not_changes_requested');
    });

    it('cancel: the requester or Approval.cancel; the approvers waiting are told', async () => {
      const [requester, a, other] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      // Someone who can't see it gets a 404; an approver who isn't the requester a 403.
      await other.agent.post(`/v1/approvals/${id}/cancel`).send({}).expect(404);
      await a.agent.post(`/v1/approvals/${id}/cancel`).send({}).expect(403);
      await requester.agent
        .post(`/v1/approvals/${id}/cancel`)
        .send({ reason: 'Not needed after all.' })
        .expect(200);
      expect((await detail(requester.agent, id)).status).toBe('cancelled');
      expect(await types(a.agent)).toContain('approval.cancelled');
      expect((await approve(a, id).expect(409)).body.code).toBe(
        'approval_closed',
      );
      await node.worker.drain();
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(id)))?.output,
      ).toEqual({ status: 'cancelled' });

      // An administrator (Approval.cancel) may cancel anyone's: the requester is told.
      const second = await ask(requester);
      await node
        .admin()
        .post(`/v1/approvals/${second}/cancel`)
        .send({})
        .expect(200);
      expect(await types(requester.agent)).toContain('approval.cancelled');
    });

    it('withdraws the request when the test item is deleted, and ends a purged record’s workflow', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { testItem, approval } = await publication(owner, editor);
      const item = { id: approval };
      await editor.agent
        .post(`/v1/approvals/${item.id}/request-changes`)
        .send({ comment: 'Shorter.' })
        .expect(200);
      // Sent back for changes, the testItem may change, or go.
      await owner.agent.delete(`/v1/test-items/${testItem}`).expect(204);
      expect(await detail(owner.agent, item.id)).toMatchObject({
        status: 'cancelled',
        outcomeReason: 'record_deleted',
      });
      await node.worker.drain();
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(item.id)))?.status,
      ).toBe('completed');

      // A record purged for good: its open requests go, and their workflows end.
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const recordId = await aTestItem();
      const purged = await requestApproval(`user:${requester.id}`, {
        subject: 'TestItem',
        recordId,
        action: 'publish',
      });
      const id = (purged as { request: { id: string } }).request.id;
      await node.worker.drain();
      const db = node.db;
      const listener = node.app
        .get(RecordPurgeRegistry)
        .of('TestItem')
        .find((one) => one.name === 'approvals')!;
      await db.transaction((tx) => listener.forget(tx, 'TestItem', [recordId]));
      await node.worker.drain();
      expect(
        await node.workflows.getStatus(approvalWorkflowId(id)),
      ).toMatchObject({
        status: 'completed',
        output: { status: 'gone' }, // its request went with the record
      });
      await a.agent.get(`/v1/approvals/${id}`).expect(404);
    });
  });

  describe('who decides', () => {
    it('refuses self-approval, and a requester whom only they could approve (422)', async () => {
      const requester = await node.user(['editor']);
      await node.user(['editor']);
      const id = await ask(requester); // the default policy: any editor
      const self = await approve(requester, id).expect(403);
      expect(self.body.code).toBe('approval_self_approval');
      // In German, as the request asks.
      const de = await requester.agent
        .post(`/v1/approvals/${id}/approve?lang=de`)
        .send({})
        .expect(403);
      expect(de.body.detail).toBe(
        'Sie können nicht über Ihre eigene Anfrage entscheiden.',
      );

      await setPolicy({ stages: [stage([users(requester)])] });
      await expect(
        requestApproval(`user:${requester.id}`, {
          subject: 'TestItem',
          recordId: await aTestItem('x'),
          action: 'publish',
        }),
      ).rejects.toMatchObject({
        response: { code: 'approval_no_approvers', stage: 'Review' },
      });
    });

    it('resolves "the lead of my unit" by role in the requester’s unit, or the nearest above', async () => {
      const admin = node.admin();
      const sales = (
        await admin
          .post('/v1/access/organizational-units')
          .send({ type: 'team', name: 'Sales' })
          .expect(201)
      ).body;
      const north = (
        await admin
          .post('/v1/access/organizational-units')
          .send({ type: 'team', name: 'North', parentId: sales.id })
          .expect(201)
      ).body;
      const support = (
        await admin
          .post('/v1/access/organizational-units')
          .send({ type: 'team', name: 'Support' })
          .expect(201)
      ).body;
      const [requester, salesLead, northLead, otherLead] = [
        await node.user([]),
        await node.user(['unit-lead']),
        await node.user(['unit-lead']),
        await node.user(['unit-lead']),
      ];
      const unitsOf = (user: User, ids: string[]) =>
        admin
          .patch(`/v1/access/users/${user.id}`)
          .send({ unitIds: ids })
          .expect(204);
      await unitsOf(requester, [north.id]);
      await unitsOf(salesLead, [sales.id]);
      await unitsOf(northLead, [north.id]);
      await unitsOf(otherLead, [support.id]);
      await setPolicy({
        stages: [stage([{ type: 'unitRole', role: 'unit-lead' }])],
      });

      const id = await ask(requester);
      const approvers = (await detail(requester.agent, id)).assignments.map(
        (x: { approverId: string }) => x.approverId,
      );
      expect(approvers).toEqual([northLead.id]);

      // The north lead's own request goes to the lead above them.
      const theirs = await ask(northLead);
      expect(
        (await detail(northLead.agent, theirs)).assignments.map(
          (x: { approverId: string }) => x.approverId,
        ),
      ).toEqual([salesLead.id]);
      // Assignments are kept: a role taken away later doesn't change who decides.
      await admin
        .patch(`/v1/access/users/${salesLead.id}`)
        .send({ roleIds: [] })
        .expect(204);
      await approve(salesLead, theirs).expect(200);
    });

    it('a delegate decides on behalf of the approver within the period, not outside it', async () => {
      const [requester, approver, delegate, later] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({ stages: [stage([users(approver)])] });
      const now = Date.now();
      await approver.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: delegate.id,
          startsAt: new Date(now - 60_000).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
        })
        .expect(201);
      await approver.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: later.id,
          startsAt: new Date(now + 86_400_000).toISOString(),
          endsAt: new Date(now + 2 * 86_400_000).toISOString(),
        })
        .expect(201);
      await approver.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: approver.id,
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now + 1000).toISOString(),
        })
        .expect(400);
      const given = await approver.agent
        .get('/v1/approvals/delegations')
        .expect(200);
      expect(
        given.body.items.map((d: { active: boolean }) => d.active).sort(),
      ).toEqual([false, true]);

      const id = await ask(requester);
      // The delegate hears of it, and finds it in their inbox.
      expect(await types(delegate.agent)).toContain('approval.requested');
      expect(
        (
          await delegate.agent
            .get('/v1/approvals?assignedToMe=true')
            .expect(200)
        ).body.items,
      ).toHaveLength(1);
      // Not yet in the period: refused.
      expect((await approve(later, id).expect(404)).body.code).toBe(
        'not_found',
      );

      await approve(delegate, id, {
        comment: 'For Ada, while she is away.',
      }).expect(200);
      const [decided] = (await detail(requester.agent, id)).assignments;
      expect(decided).toMatchObject({
        approverId: approver.id,
        decidedBy: delegate.id,
        onBehalfOf: approver.id,
        status: 'approved',
      });
    });

    it('one decision per person per stage, even standing in for another approver', async () => {
      const [requester, a, d, c] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [stage([users(a, d, c)], { mode: { type: 'quorum', n: 2 } })],
      });
      const now = Date.now();
      await a.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: d.id,
          startsAt: new Date(now - 60_000).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
        })
        .expect(201);
      const id = await ask(requester);
      // d decides once: for their own assignment and for a's, as one person.
      await approve(d, id).expect(200);
      const shown = await detail(requester.agent, id);
      expect(shown.status).toBe('pending'); // one person of the two needed
      expect(
        shown.assignments.map(
          (x: {
            approverId: string;
            status: string;
            decidedBy: string | null;
            onBehalfOf: string | null;
          }) => [x.approverId, x.status, x.decidedBy, x.onBehalfOf],
        ),
      ).toEqual([
        [a.id, 'approved', d.id, a.id],
        [d.id, 'approved', d.id, null],
        [c.id, 'pending', null, null],
      ]);
      // Deciding again is no second vote; deciding otherwise is refused.
      await approve(d, id).expect(200);
      const otherwise = await d.agent
        .post(`/v1/approvals/${id}/reject`)
        .send({ comment: 'No.' })
        .expect(409);
      expect(otherwise.body.code).toBe('approval_already_decided');
      await approve(c, id).expect(200);
      expect((await detail(requester.agent, id)).status).toBe('approved');
    });

    it('two approvers at once in an any-stage: exactly one wins, the other gets a 409', async () => {
      const [requester, a, b] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({ stages: [stage([users(a, b)])] });
      const id = await ask(requester);
      const answers = await Promise.all([
        approve(a, id),
        b.agent.post(`/v1/approvals/${id}/reject`).send({ comment: 'No.' }),
      ]);
      expect(
        answers.map((answer) => answer.status).sort((x, y) => x - y),
      ).toEqual([200, 409]);
      const loser = answers.find((answer) => answer.status === 409)!;
      expect(['approval_already_decided', 'approval_closed']).toContain(
        loser.body.code,
      );
      const shown = await detail(requester.agent, id);
      expect(
        shown.assignments.filter(
          (x: { status: string }) => x.status !== 'closed',
        ),
      ).toHaveLength(1);
    });

    it('hides requests from others (404), refuses non-assignees (403), shows administrators everything', async () => {
      const [requester, a, stranger] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      await stranger.agent.get(`/v1/approvals/${id}`).expect(404);
      await approve(stranger, id).expect(404);
      expect(
        (await stranger.agent.get('/v1/approvals').expect(200)).body.items,
      ).toHaveLength(0);
      // An administrator reads it (Approval.read) but isn't an approver.
      const admin = node.admin();
      expect(
        (await admin.get('/v1/approvals?status=pending').expect(200)).body
          .items,
      ).toHaveLength(1);
      const notMine = await admin
        .post(`/v1/approvals/${id}/approve`)
        .send({})
        .expect(403);
      expect(notMine.body.code).toBe('approval_not_assignee');
      // An approver sees it, and may decide.
      expect((await detail(a.agent, id)).can).toEqual({
        decide: true,
        cancel: false,
        resubmit: false,
        abandon: false,
      });
      // Policies are for those with Approval.managePolicies.
      await a.agent.get('/v1/approvals/policies').expect(403);
    });

    it('refuses a decision on a stale ETag (412)', async () => {
      const [requester, a, b] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [stage([users(a, b)], { mode: { type: 'all' } })],
      });
      const id = await ask(requester);
      const read = await a.agent.get(`/v1/approvals/${id}`).expect(200);
      await approve(b, id).expect(200);
      const stale = await a.agent
        .post(`/v1/approvals/${id}/approve`)
        .set('If-Match', read.headers.etag)
        .send({})
        .expect(412);
      expect(stale.body.code).toBe('precondition_failed');
    });
  });

  describe('time: reminders, escalation, expiry', () => {
    it('reminds, then escalates an overdue stage, then expires it', async () => {
      const [requester, a, boss] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [
          stage([users(a)], {
            remindAfter: '1h',
            dueAfter: '1d',
            onOverdue: 'escalate',
            escalateTo: [users(boss)],
            escalationDueAfter: '1d',
          }),
        ],
      });
      const first = await ask(requester);
      node.clock.advance('1h');
      await node.worker.drain();
      expect(await types(a.agent)).toContain('approval.reminder');
      node.clock.advance('23h');
      await node.worker.drain();
      expect(await types(boss.agent)).toContain('approval.escalated');
      const escalated = await detail(boss.agent, first);
      expect(
        escalated.assignments.map(
          (x: { approverId: string; escalated: boolean }) => [
            x.approverId,
            x.escalated,
          ],
        ),
      ).toEqual([
        [a.id, false],
        [boss.id, true],
      ]);
      // Who didn't answer in time is closed out: the escalation decides.
      expect(escalated.assignments[0].status).toBe('closed');
      await approve(boss, first).expect(200);
      expect((await detail(requester.agent, first)).status).toBe('approved');

      // Nobody decides, even after the escalation: it expires, and the requester is told.
      const second = await ask(requester);
      node.clock.advance('1d');
      await node.worker.drain();
      node.clock.advance('1d');
      await node.worker.drain();
      expect(await detail(requester.agent, second)).toMatchObject({
        status: 'expired',
        outcomeReason: 'overdue',
      });
      expect(await types(requester.agent)).toContain('approval.expired');
    });

    it('escalation hands an all-stage’s undecided part to the escalation', async () => {
      const [requester, a, b, boss] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [
          stage([users(a, b)], {
            mode: { type: 'all' },
            dueAfter: '1d',
            onOverdue: 'escalate',
            escalateTo: [users(boss)],
          }),
        ],
      });
      const id = await ask(requester);
      await approve(b, id).expect(200);
      node.clock.advance('1d');
      await node.worker.drain();
      // a never answered: closed out, so the boss's approval completes the stage.
      await approve(boss, id).expect(200);
      expect((await detail(requester.agent, id)).status).toBe('approved');
    });

    it('expires a request sent back for changes that is never resubmitted', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])], resubmitWithin: '2d' });
      const id = await ask(requester);
      await a.agent
        .post(`/v1/approvals/${id}/request-changes`)
        .send({ comment: 'More detail.' })
        .expect(200);
      await node.worker.drain();
      node.clock.advance('2d');
      await node.worker.drain();
      expect(await detail(requester.agent, id)).toMatchObject({
        status: 'expired',
        outcomeReason: 'not_resubmitted',
      });
    });
  });
});
