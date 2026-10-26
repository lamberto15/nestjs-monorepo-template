import { eq, sql } from 'drizzle-orm';
import type { UserPrincipal } from '../src/iam/auth/principal.js';
import type request from 'supertest';
import { approvalWorkflowId } from '../src/platform/approvals/approval-events.js';
import { approvalRequests } from '../src/platform/approvals/approvals.tables.js';
import { ApprovalEngine } from '../src/platform/approvals/approval-engine.service.js';
import { TestItemsService } from './fixtures/test-items/test-items.service.js';
import {
  TEST_ITEM_PUBLISH_APPROVAL,
  TestItemPublishApproval,
} from './fixtures/test-items/test-item-approvals.js';
import { RevisionsService } from '../src/platform/revisions/revisions.service.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { connect, type TestApp } from './support.js';
import { approvalsHarness } from './approvals.support.js';

// /metrics answers with a token only, read when AppModule loads (before the imports run).
const METRICS = vi.hoisted(() => {
  const token = 'metrics-token-for-the-approvals-tests';
  process.env.METRICS_TOKEN = token;
  return token;
});

describe('approvals (e2e)', () => {
  const harness = approvalsHarness();
  const {
    requestApproval,
    erase,
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

  describe('escalation and removed approvers settle the stage', () => {
    it('an escalation that leaves a quorum out of reach decides the stage', async () => {
      const [requester, a, b, c, d] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      const escalating = {
        mode: { type: 'quorum', n: 2 },
        dueAfter: '1d',
        onOverdue: 'escalate',
        escalateTo: [users(d)],
      };
      await setPolicy({ stages: [stage([users(a, b, c)], escalating)] });
      // a rejects; b and c never answer; the escalation to d leaves at most one approval.
      const rejected = await ask(requester);
      await a.agent
        .post(`/v1/approvals/${rejected}/reject`)
        .send({ comment: 'No.' })
        .expect(200);
      node.clock.advance('1d');
      await node.worker.drain();
      expect((await detail(requester.agent, rejected)).status).toBe('rejected');

      // Nobody answers: d alone can't make two, so the quorum isn't lowered: the request fails.
      await setPolicy({ stages: [stage([users(a, b)], escalating)] });
      const unreachable = await ask(requester);
      node.clock.advance('1d');
      await node.worker.drain();
      expect(await detail(requester.agent, unreachable)).toMatchObject({
        status: 'failed',
        outcomeReason: 'no_approvers',
      });
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(unreachable)))
          ?.output,
      ).toEqual({ status: 'failed' });

      // a approved, b silent: the escalation keeps two needed, d's approval makes them.
      const kept = await ask(requester);
      await approve(a, kept).expect(200);
      node.clock.advance('1d');
      await node.worker.drain();
      expect((await detail(requester.agent, kept)).status).toBe('pending');
      await approve(d, kept).expect(200);
      expect((await detail(requester.agent, kept)).status).toBe('approved');

      // A request for a quorum above the approvers there are is refused at once.
      await setPolicy({
        stages: [stage([users(a, b)], { mode: { type: 'quorum', n: 3 } })],
      });
      await expect(
        requestApproval(`user:${requester.id}`, {
          subject: 'TestItem',
          recordId: await aTestItem(),
          action: 'publish',
        }),
      ).rejects.toMatchObject({ response: { code: 'approval_no_approvers' } });
    });

    it('a delegate who is also an approver doesn’t stall an all-stage', async () => {
      const [requester, a, d] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [stage([users(a, d)], { mode: { type: 'all' } })],
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
      await approve(d, id).expect(200); // for a and for themselves
      expect((await detail(requester.agent, id)).status).toBe('approved');
    });

    it('a deactivated (or deleted) approver is closed out; their stage settles; their delegations end', async () => {
      const [requester, a, b, c, d] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [stage([users(a, b)], { mode: { type: 'all' } })],
      });
      const id = await ask(requester);
      const now = Date.now();
      await a.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: d.id,
          startsAt: new Date(now - 60_000).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
        })
        .expect(201);
      await node
        .admin()
        .patch(`/v1/access/users/${a.id}`)
        .send({ active: false })
        .expect(204);
      const shown = await detail(requester.agent, id);
      expect(shown.assignments[0]).toMatchObject({
        approverId: a.id,
        status: 'closed',
      });
      expect(
        (await d.agent.get('/v1/approvals/delegations').expect(200)).body.items,
      ).toEqual([]);
      await approve(b, id).expect(200); // the stage no longer waits for a
      expect((await detail(requester.agent, id)).status).toBe('approved');

      // Deleted (erase): the same, and a stage left with nobody fails.
      await setPolicy({ stages: [stage([users(c)])] });
      const alone = await ask(requester);
      await erase({ kind: 'user', id: c.id } as UserPrincipal);
      const gone = await detail(requester.agent, alone);
      expect(gone).toMatchObject({
        status: 'failed',
        outcomeReason: 'no_approvers',
      });
      // Inside the job, the job is the actor of what it ended.
      expect(
        gone.timeline
          .filter((event: { type: string }) =>
            ['approver_removed', 'failed'].includes(event.type),
          )
          .map((event: { actor: string }) => event.actor),
      ).toEqual(['system:account-deletion', 'system:account-deletion']);
      await node.worker.drain();
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(alone)))?.output,
      ).toEqual({ status: 'failed' });
    });

    it('a deactivation over HTTP records the administrator, never the system, as the actor', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      const adminId = (await node.admin().get('/v1/auth/me').expect(200)).body
        .user.id as string;
      await node
        .admin()
        .patch(`/v1/access/users/${a.id}`)
        .send({ active: false })
        .expect(204);
      const shown = await detail(requester.agent, id);
      expect(shown).toMatchObject({
        status: 'failed',
        outcomeReason: 'no_approvers',
      });
      // The request's principal is the actor of what followed from it: the
      // system principal never acts within a request.
      expect(
        shown.timeline
          .filter((event: { type: string }) =>
            ['approver_removed', 'failed'].includes(event.type),
          )
          .map((event: { type: string; actor: string }) => [
            event.type,
            event.actor,
          ]),
      ).toEqual([
        ['approver_removed', `user:${adminId}`],
        ['failed', `user:${adminId}`],
      ]);
      const audited = await node
        .admin()
        .get('/v1/access/audit?action=approval.failed')
        .expect(200);
      expect(audited.body.items).toHaveLength(1);
      expect(audited.body.items[0]).toMatchObject({
        actor: `user:${adminId}`,
        details: { reason: 'no_approvers' },
      });
      await node.worker.drain(); // the workflow concludes with what the request ended
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(id)))?.output,
      ).toEqual({ status: 'failed' });
    });
  });

  describe('security', () => {
    it('S1: a requester can’t switch the approval off for themselves', async () => {
      const editor = await node.user(['editor']);
      const mine = await editor.agent
        .put('/v1/settings/testItems.publishApproval/mine')
        .send({ value: false })
        .expect(400);
      expect(mine.body.code).toBe('validation_failed');
    });

    it('S2: nobody decides, withdraws or delegates while impersonating; delegations are capped', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      const admin = await node.signIn(
        process.env.ADMIN_EMAIL!,
        process.env.ADMIN_PASSWORD!,
      );
      await admin.post(`/v1/access/users/${a.id}/impersonate`).expect(204);
      const asA = await admin
        .post(`/v1/approvals/${id}/approve`)
        .send({})
        .expect(403);
      expect(asA.body.code).toBe('approval_impersonation');
      const now = Date.now();
      const planted = await admin
        .post('/v1/approvals/delegations')
        .send({
          toUserId: requester.id,
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
        })
        .expect(403);
      expect(planted.body.code).toBe('approval_impersonation');
      await admin.post('/v1/auth/impersonation/stop').expect(204);

      const tooLong = await a.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: requester.id,
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now + 91 * 86_400_000).toISOString(),
        })
        .expect(400);
      expect(tooLong.body.errors[0].path).toBe('endsAt');
    });

    it('S3: what is approved is what is applied', async () => {
      expect(
        TEST_ITEM_PUBLISH_APPROVAL.payload.safeParse({ title: 'x'.repeat(201) })
          .success,
      ).toBe(false);
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const publishing = () => publication(owner, editor);

      // Approved, not applied yet: the testItem still can't change.
      const first = await publishing();
      await approve(editor, first.approval).expect(200);
      const locked = await owner.agent
        .patch(`/v1/test-items/${first.testItem}`)
        .send({ title: 'Changed' })
        .expect(409);
      expect(locked.body.code).toBe('approval_pending');
      await node.worker.drain();
      expect(
        (await owner.agent.get(`/v1/test-items/${first.testItem}`).expect(200))
          .body.publishedAt,
      ).toEqual(expect.any(String));

      // A change that went around the lock: not published as approved.
      const second = await publishing();
      await approve(editor, second.approval).expect(200);
      const db = node.db;
      await db
        .update(testItems)
        .set({ body: 'changed behind the approvers' })
        .where(eq(testItems.id, second.testItem));
      await node.worker.drain();
      expect(await detail(owner.agent, second.approval)).toMatchObject({
        status: 'failed',
        outcomeReason: 'record_changed',
      });
      expect(
        (await owner.agent.get(`/v1/test-items/${second.testItem}`).expect(200))
          .body.publishedAt,
      ).toBeNull();

      // A request waits for a change in progress (the record's lock), and proposes what it saved.
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const recordId = await aTestItem('Before');
      let made = false;
      const { asked } = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`approval-record:TestItem:${recordId}`}))`,
        );
        await tx
          .update(testItems)
          .set({ title: 'After' })
          .where(eq(testItems.id, recordId));
        const pending = requestApproval(`user:${requester.id}`, {
          subject: 'TestItem',
          recordId,
          action: 'publish',
        }).then((result) => {
          made = true;
          return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(made).toBe(false); // waiting for the change's transaction
        return { asked: pending }; // not awaited here: it waits for this transaction
      });
      const result = await asked;
      expect(result.required && result.request.payload).toEqual({
        title: 'After',
      });
    });

    it('S4: resubmitting what wasn’t sent back is a 409 before anything else', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      await approve(a, id).expect(200);
      const refused = await requester.agent
        .post(`/v1/approvals/${id}/resubmit`)
        .send({ payload: { title: 42 } })
        .expect(409);
      expect(refused.body.code).toBe('approval_not_changes_requested');
    });
  });

  describe('applying the outcome', () => {
    it('outcomeAppliedAt is null until the handler has run, then set, on every view; approval.applied tells the requester and the approver, nobody else', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const bystander = await node.user(['editor']);
      // Sockets of users sign in with their access token.
      const tokenOf = async (who: { email: string; password: string }) =>
        (
          await node
            .http()
            .post('/v1/auth/token')
            .send({ email: who.email, password: who.password })
            .expect(200)
        ).body.accessToken as string;
      const sockets = await Promise.all(
        [owner, editor, bystander].map(async (who) =>
          connect(node, await tokenOf(who as never)),
        ),
      );
      const heard: Record<string, unknown>[][] = [[], [], []];
      sockets.forEach((socket, index) =>
        socket.on('approval.applied', (data: Record<string, unknown>) =>
          heard[index]!.push(data),
        ),
      );
      try {
        const { testItem, approval } = await publication(owner, editor);
        const listed = async (agent: request.Agent) =>
          (
            (
              await agent
                .get(`/v1/approvals?recordId=${testItem}&requestedByMe=true`)
                .expect(200)
            ).body.items as { outcomeAppliedAt: string | null }[]
          )[0]!.outcomeAppliedAt;
        expect(
          (await detail(owner.agent, approval)).outcomeAppliedAt,
        ).toBeNull();
        const decision = await approve(editor, approval).expect(200);
        // Approved, the handler not run yet.
        expect(decision.body).toMatchObject({
          status: 'approved',
          outcomeAppliedAt: null,
        });
        expect(
          (await detail(owner.agent, approval)).outcomeAppliedAt,
        ).toBeNull();
        expect(await listed(owner.agent)).toBeNull();
        expect(heard.flat()).toEqual([]);

        await node.worker.drain(); // the outcome's handler publishes
        const done = await detail(owner.agent, approval);
        expect(done.status).toBe('approved');
        expect(done.outcomeAppliedAt).toEqual(expect.any(String));
        expect(await listed(owner.agent)).toBe(done.outcomeAppliedAt);
        // The event carries the same instant, to the requester and the approver.
        const event = {
          id: approval,
          subject: 'TestItem',
          recordId: testItem,
          outcomeAppliedAt: done.outcomeAppliedAt,
        };
        await vi.waitFor(() => expect(heard[0]).toHaveLength(1), {
          timeout: 5000,
        });
        await vi.waitFor(() => expect(heard[1]).toHaveLength(1), {
          timeout: 5000,
        });
        expect(heard[0]).toEqual([event]);
        expect(heard[1]).toEqual([event]);
        // A user who isn't part of the request hears nothing.
        expect(heard[2]).toEqual([]);
      } finally {
        sockets.forEach((socket) => socket.disconnect());
      }
    });

    it('outcomeAppliedAt stays null through changes requested and a resubmission, until the new round is applied', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { testItem, approval } = await publication(owner, editor);
      await editor.agent
        .post(`/v1/approvals/${approval}/request-changes`)
        .send({ comment: 'A better title.' })
        .expect(200);
      await node.worker.drain(); // round 0 concludes as changes_requested: nothing applied
      expect((await detail(owner.agent, approval)).outcomeAppliedAt).toBeNull();
      await owner.agent
        .patch(`/v1/test-items/${testItem}`)
        .send({ title: 'A better title' })
        .expect(200);
      const resubmitted = await owner.agent
        .post(`/v1/approvals/${approval}/resubmit`)
        .send({})
        .expect(200);
      expect(resubmitted.body.outcomeAppliedAt).toBeNull();
      await node.worker.drain(); // round 1's first stage
      await approve(editor, approval).expect(200);
      expect((await detail(owner.agent, approval)).outcomeAppliedAt).toBeNull();
      await node.worker.drain();
      expect((await detail(owner.agent, approval)).outcomeAppliedAt).toEqual(
        expect.any(String),
      );
    });

    it('N1: a request approved after a resubmission is applied, and locks the record until it is', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { testItem, approval } = await publication(owner, editor);
      await editor.agent
        .post(`/v1/approvals/${approval}/request-changes`)
        .send({ comment: 'A better title.' })
        .expect(200);
      await node.worker.drain(); // round 0 concludes as changes_requested
      await owner.agent
        .patch(`/v1/test-items/${testItem}`)
        .send({ title: 'A better title' })
        .expect(200);
      await owner.agent
        .post(`/v1/approvals/${approval}/resubmit`)
        .send({})
        .expect(200);
      await node.worker.drain(); // round 1's first stage
      await approve(editor, approval).expect(200);
      // Approved, not applied yet: still locked.
      expect(
        (
          await owner.agent
            .patch(`/v1/test-items/${testItem}`)
            .send({ title: 'Sneaked in' })
            .expect(409)
        ).body.code,
      ).toBe('approval_pending');
      await node.worker.drain(); // round 1 concludes: published
      expect(
        (await owner.agent.get(`/v1/test-items/${testItem}`).expect(200)).body,
      ).toMatchObject({
        publishedAt: expect.any(String),
        title: 'A better title',
      });
    });

    it('N2: a handler may apply the change through the feature’s guarded writes', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { testItem, approval } = await publication(owner, editor);
      const testItemsService = node.app.get(TestItemsService);
      // The handler writes through TestItemsService.update, which calls assertNotPending.
      vi.spyOn(
        node.app.get(TestItemPublishApproval),
        'onApproved',
      ).mockImplementation(async ({ request, actor }) => {
        const current = await testItemsService.findOne(request.recordId);
        await testItemsService.update(
          {
            kind: 'user',
            id: owner.id,
            name: 'owner',
            email: 'owner@example.com',
          } as UserPrincipal,
          current,
          { title: 'Applied through the guarded path' },
        );
        await testItemsService.publish(request.recordId, actor);
      });
      await approve(editor, approval).expect(200);
      // Outside the handler, the same guarded write is still refused while approved, not applied.
      expect(
        (
          await owner.agent
            .patch(`/v1/test-items/${testItem}`)
            .send({ title: 'Not through the handler' })
            .expect(409)
        ).body.code,
      ).toBe('approval_pending');
      await node.worker.drain();
      expect(
        (await owner.agent.get(`/v1/test-items/${testItem}`).expect(200)).body,
      ).toMatchObject({
        publishedAt: expect.any(String),
        title: 'Applied through the guarded path',
      });
    });

    it('N1: resubmitted before round 0 concluded, round 1 is still applied when approved', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { testItem, approval } = await publication(owner, editor);
      await editor.agent
        .post(`/v1/approvals/${approval}/request-changes`)
        .send({ comment: 'Again, please.' })
        .expect(200);
      // Not drained: the resubmission lands before conclude-0 runs.
      await owner.agent
        .post(`/v1/approvals/${approval}/resubmit`)
        .send({})
        .expect(200);
      await node.worker.drain(); // conclude-0 (changes requested), then round 1's first stage
      await approve(editor, approval).expect(200);
      await node.worker.drain();
      expect(
        (await owner.agent.get(`/v1/test-items/${testItem}`).expect(200)).body
          .publishedAt,
      ).toEqual(expect.any(String));
    });

    it('conclude doesn’t mark applied a request that stopped being approved while its handler ran', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { approval } = await publication(owner, editor);
      const db = node.db;
      vi.spyOn(
        node.app.get(TestItemPublishApproval),
        'onApproved',
      ).mockImplementation(async ({ request }) => {
        // Ended by someone else meanwhile (as an abandon would, were it let through).
        await db
          .update(approvalRequests)
          .set({ status: 'failed', outcomeReason: 'abandoned' })
          .where(eq(approvalRequests.id, request.id));
      });
      await approve(editor, approval).expect(200);
      await node.worker.drain();
      const [row] = await db
        .select({ applied: approvalRequests.outcomeAppliedAt })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approval));
      expect(row!.applied).toBeNull();
    });

    it('N4: a handler that gives up for good fails the request (apply_failed) and unlocks the record', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { testItem, approval } = await publication(owner, editor);
      vi.spyOn(
        node.app.get(TestItemPublishApproval),
        'onApproved',
      ).mockRejectedValue(new Error('the other system is down'));
      await approve(editor, approval).expect(200);
      for (let tries = 0; tries < 12; tries++) {
        await node.worker.drain();
        node.clock.advance('1h'); // past each retry's backoff
      }
      await node.worker.drain();
      expect(await detail(owner.agent, approval)).toMatchObject({
        status: 'failed',
        outcomeReason: 'apply_failed',
      });
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(approval)))?.output,
      ).toEqual({ status: 'failed' });
      expect(await types(owner.agent)).toContain('approval.failed');
      // Unlocked: the testItem can change again.
      await owner.agent
        .patch(`/v1/test-items/${testItem}`)
        .send({ title: 'Free again' })
        .expect(200);
    });

    it('N4: an administrator abandons a stuck approved request; the gauge shows the wait', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const { testItem, approval } = await publication(owner, editor);
      await approve(editor, approval).expect(200); // not drained: not applied
      // The gauge: how long the oldest approved request has waited.
      const db = node.db;
      await db
        .update(approvalRequests)
        .set({ endedAt: sql`now() - interval '2 hours'` })
        .where(eq(approvalRequests.id, approval));
      const metrics = (
        await node
          .http()
          .get('/metrics')
          .set('Authorization', `Bearer ${METRICS}`)
          .expect(200)
      ).text;
      expect(
        Number(/^approvals_unapplied_seconds (\S+)$/m.exec(metrics)![1]),
      ).toBeGreaterThanOrEqual(7200);
      // can.abandon: Approval.manage on an approved, unapplied request.
      expect(
        (await editor.agent.get(`/v1/approvals/${approval}`).expect(200)).body
          .can.abandon,
      ).toBe(false);
      // Only with Approval.manage, never while impersonating.
      await editor.agent
        .post(`/v1/approvals/${approval}/abandon`)
        .send({})
        .expect(403);
      const admin = await node.signIn(
        process.env.ADMIN_EMAIL!,
        process.env.ADMIN_PASSWORD!,
      );
      // Its workflow is due to apply it: it might be applying right now.
      const running = await admin
        .post(`/v1/approvals/${approval}/abandon`)
        .send({})
        .expect(409);
      expect(running.body).toMatchObject({ code: 'approval_not_stuck' });
      expect(
        (await admin.get(`/v1/approvals/${approval}`).expect(200)).body.can
          .abandon,
      ).toBe(true); // the workflow check is left to call time
      // The workflow is gone (terminated, as after a failure nobody retried): now it may go.
      await node.workflows.terminate(approvalWorkflowId(approval), 'stuck');
      await node.worker.drain(); // the worker ends it
      const handler = node.app.get(
        TestItemPublishApproval,
      ) as TestItemPublishApproval & {
        onFailed?: (outcome: unknown) => Promise<void>;
      };
      const onFailed = vi.fn(async () => undefined);
      handler.onFailed = onFailed;
      const stale = await admin
        .post(`/v1/approvals/${approval}/abandon`)
        .set('If-Match', '"not-the-current-tag"')
        .send({})
        .expect(412);
      expect(stale.body.code).toBe('precondition_failed');
      const current = await admin.get(`/v1/approvals/${approval}`).expect(200);
      const abandoned = await admin
        .post(`/v1/approvals/${approval}/abandon`)
        .set('If-Match', current.headers.etag)
        .send({ reason: 'The publisher is gone.' })
        .expect(200);
      expect(abandoned.body).toMatchObject({
        status: 'failed',
        outcomeReason: 'abandoned',
      });
      expect(onFailed).toHaveBeenCalledTimes(1); // its workflow being gone, abandon runs it
      delete handler.onFailed;
      expect(
        (
          await admin
            .post(`/v1/approvals/${approval}/abandon`)
            .send({})
            .expect(409)
        ).body.code,
      ).toBe('approval_not_stuck');
      // Unlocked, and nothing was published.
      expect(
        (await owner.agent.get(`/v1/test-items/${testItem}`).expect(200)).body
          .publishedAt,
      ).toBeNull();
      await owner.agent
        .patch(`/v1/test-items/${testItem}`)
        .send({ title: 'Free again' })
        .expect(200);
      const audit = await admin
        .get(`/v1/access/audit?action=approval.failed`)
        .expect(200);
      expect(audit.body.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('the record lock, in the feature’s own writes', () => {
    it('S3e: a request waits for a testItem update in progress, then proposes what it saved', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const recordId = await aTestItem('Before');
      // Hold the update open inside its transaction (after its checks, before its commit).
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      const revisions = node.app.get(RevisionsService);
      const original = revisions.record.bind(revisions);
      vi.spyOn(revisions, 'record').mockImplementationOnce(async (...args) => {
        inside();
        await held;
        return original(...args);
      });
      const update = node
        .admin()
        .patch(`/v1/test-items/${recordId}`)
        .send({ title: 'After' })
        .then((res) => res);
      await entered;
      let made = false;
      const asked = requestApproval(`user:${requester.id}`, {
        subject: 'TestItem',
        recordId,
        action: 'publish',
      }).then((result) => {
        made = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(made).toBe(false); // waiting for the update's transaction (its record lock)
      release();
      expect((await update).status).toBe(200);
      const result = await asked;
      expect(result.required && result.request.payload).toEqual({
        title: 'After',
      });
    });

    it('S4: resubmitting what wasn’t sent back takes no lock, resolves no approver, describes nothing', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      await approve(a, id).expect(200);
      const engine = node.app.get(ApprovalEngine);
      const lock = vi.spyOn(engine, 'lock');
      const startable = vi.spyOn(engine, 'startable');
      const describe = vi.spyOn(
        node.app.get(TestItemPublishApproval),
        'describe',
      );
      const refused = await requester.agent
        .post(`/v1/approvals/${id}/resubmit`)
        .send({})
        .expect(409);
      expect(refused.body.code).toBe('approval_not_changes_requested');
      expect(lock).not.toHaveBeenCalled();
      expect(startable).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();
    });
  });
});
