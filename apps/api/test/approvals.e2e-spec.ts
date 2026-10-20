import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { UserPrincipal } from '../src/iam/auth/principal.js';
import { SystemContext } from '../src/iam/access/system-context.js';
import {
  ACCOUNT_DELETION_JOB,
  APPROVALS_JOB,
} from '../src/platform/platform.jobs.js';
import { TEST_ITEM_PUBLICATION_JOB } from './fixtures/test-items/test-item.policy.js';
import { z } from 'zod';
import type request from 'supertest';
import { ApprovalsRegistry } from '../src/platform/approvals/approvals.registry.js';
import { ApprovalsService } from '../src/platform/approvals/approvals.service.js';
import { approvalWorkflowId } from '../src/platform/approvals/approval-events.js';
import type { ApprovalLifecycleEvent } from '../src/platform/approvals/approval.types.js';
import { approvalRequests } from '../src/platform/approvals/approvals.tables.js';
import { ApprovalEngine } from '../src/platform/approvals/approval-engine.service.js';
import { TestItemsService } from './fixtures/test-items/test-items.service.js';
import {
  TEST_ITEM_PUBLISH_APPROVAL,
  TestItemPublishApproval,
} from './fixtures/test-items/test-item-approvals.js';
import { RevisionsService } from '../src/platform/revisions/revisions.service.js';
import { NotificationsService } from '../src/platform/notifications/notifications.service.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { RecordPurgeRegistry } from '../src/iam/resources/record-purge.registry.js';
import { bootApp, connect, type TestApp, webhookReceiver } from './support.js';

// /metrics answers with a token only, read when AppModule loads (before the imports run).
const METRICS = vi.hoisted(() => {
  const token = 'metrics-token-for-the-approvals-tests';
  process.env.METRICS_TOKEN = token;
  return token;
});

type User = { id: string; agent: request.Agent };

describe('approvals (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
    // The example action (TestItem.publish) needs approval only with its flag on.
    await node
      .admin()
      .put('/v1/settings/testItems.publishApproval')
      .send({ value: true })
      .expect(200);
  });

  afterEach(async () => {
    await node.close();
  });

  const service = () => node.app.get(ApprovalsService);

  /**
   * Asks for approval on a person's behalf (`user:<id>`) as a feature's
   * publication does: inside its system job, which the audit
   * entry names. Outside a request, nothing else asks with a key.
   */
  const requestApproval = (...args: Parameters<ApprovalsService['request']>) =>
    node.app
      .get(SystemContext)
      .run(TEST_ITEM_PUBLICATION_JOB, () => service().request(...args), {
        transaction: false,
        tenantId: node.tenantId,
      });

  /** Erases a person's approvals data as the account deletion job does: as `system:account-deletion`. */
  const erase = (user: UserPrincipal) =>
    node.app
      .get(SystemContext)
      .run(ACCOUNT_DELETION_JOB, (_system, tx) => service().erase(tx, user), {
        tenantId: node.tenantId,
      });

  /** Stores a version of TestItem.publish's policy (a runtime override). */
  const setPolicy = (policy: Record<string, unknown>) =>
    node
      .admin()
      .put('/v1/approvals/policies/TestItem.publish')
      .send(policy)
      .expect(200);

  const stage = (approvers: unknown[], more: Record<string, unknown> = {}) => ({
    name: 'Review',
    approvers,
    ...more,
  });
  const users = (...people: User[]) => ({
    type: 'users',
    userIds: people.map((person) => person.id),
  });

  /**
   * A test item to approve (its title is the payload, read from it), written
   * by the administrator and left unpublished: nothing asks for approval
   * but the test.
   */
  async function aTestItem(title = 'Q3 report') {
    const written = await node
      .writeItem(node.admin(), {
        title,
        body: 'x',
      })
      .expect(201);
    return written.body.id as string;
  }

  /** Asks for approval as a feature does (the service), then lets the workflow start the stage. */
  async function ask(requester: User, title = 'Q3 report') {
    const result = await requestApproval(`user:${requester.id}`, {
      subject: 'TestItem',
      recordId: await aTestItem(title),
      action: 'publish',
    });
    if (!result.required) {
      throw new Error('approval was not required');
    }
    await node.worker.drain();
    return result.request.id;
  }

  const detail = async (agent: request.Agent, id: string) =>
    (await agent.get(`/v1/approvals/${id}`).expect(200)).body;

  const types = async (agent: request.Agent) =>
    (
      (await agent.get('/v1/notifications').expect(200)).body.items as {
        type: string;
        data: Record<string, unknown>;
      }[]
    ).map((item) => item.type);

  const approve = (
    user: User,
    id: string,
    body: Record<string, unknown> = {},
  ) => user.agent.post(`/v1/approvals/${id}/approve`).send(body);

  /**
   * A test item its owner asked to publish (POST /test-items/:id/publish),
   * assigned to the editors: the item and the approval's id.
   */
  async function publication(owner: User, editor: User) {
    const created = await node.writeItem(owner.agent).expect(201);
    const asked = await owner.agent
      .post(`/v1/test-items/${created.body.id}/publish`)
      .expect(200);
    expect(asked.body.published).toBe(false);
    await node.worker.drain(); // the approval assigns the editors
    const [item] = (
      await editor.agent
        .get(`/v1/approvals?assignedToMe=true&recordId=${created.body.id}`)
        .expect(200)
    ).body.items;
    return { testItem: created.body.id as string, approval: item.id as string };
  }

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

    it('resolves "the lead of my team" by role in the requester’s team, or the nearest above', async () => {
      const admin = node.admin();
      const sales = (
        await admin.post('/v1/access/teams').send({ name: 'Sales' }).expect(201)
      ).body;
      const north = (
        await admin
          .post('/v1/access/teams')
          .send({ name: 'North', parentId: sales.id })
          .expect(201)
      ).body;
      const support = (
        await admin
          .post('/v1/access/teams')
          .send({ name: 'Support' })
          .expect(201)
      ).body;
      const [requester, salesLead, northLead, otherLead] = [
        await node.user([]),
        await node.user(['team-lead']),
        await node.user(['team-lead']),
        await node.user(['team-lead']),
      ];
      const teamsOf = (user: User, ids: string[]) =>
        admin
          .patch(`/v1/access/users/${user.id}`)
          .send({ teamIds: ids })
          .expect(204);
      await teamsOf(requester, [north.id]);
      await teamsOf(salesLead, [sales.id]);
      await teamsOf(northLead, [north.id]);
      await teamsOf(otherLead, [support.id]);
      await setPolicy({
        stages: [stage([{ type: 'teamRole', role: 'team-lead' }])],
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

  describe('the inbox for ordinary users: can, etag, decidedByMe', () => {
    type Item = {
      id: string;
      can: {
        decide: boolean;
        cancel: boolean;
        resubmit: boolean;
        abandon: boolean;
      };
      etag: string;
    };
    const inbox = async (agent: request.Agent, query = '') =>
      (await agent.get(`/v1/approvals${query}`).expect(200)).body
        .items as Item[];
    const ids = (items: Item[]) => items.map((item) => item.id).sort();

    it('each item carries the can and the etag its GET would give the reader; decide from the list with If-Match', async () => {
      const [requester, a, b, delegate] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({
        stages: [stage([users(a, b)], { mode: { type: 'all' } })],
      });
      const now = Date.now();
      await b.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: delegate.id,
          startsAt: new Date(now - 60_000).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
        })
        .expect(201);
      const id = await ask(requester);
      const admin = node.admin();
      // Each reader's item is what GET /approvals/{id} answers them: its can, its ETag.
      for (const agent of [requester.agent, a.agent, delegate.agent, admin]) {
        const [item] = (await inbox(agent)).filter((x) => x.id === id);
        const read = await agent.get(`/v1/approvals/${id}`).expect(200);
        expect(item!.can).toEqual(read.body.can);
        expect(item!.etag).toBe(read.headers.etag);
      }
      const [mine] = await inbox(requester.agent);
      expect(mine!.can).toEqual({
        decide: false,
        cancel: true,
        resubmit: false,
        abandon: false,
      });
      const [theirs] = await inbox(a.agent, '?assignedToMe=true');
      expect(theirs!.can).toEqual({
        decide: true,
        cancel: false,
        resubmit: false,
        abandon: false,
      });
      // The delegate decides for b; an administrator reads (Approval.read) and may cancel, never decide.
      expect((await inbox(delegate.agent))[0]!.can.decide).toBe(true);
      expect((await inbox(admin, '?status=pending'))[0]!.can).toEqual({
        decide: false,
        cancel: true,
        resubmit: false,
        abandon: false,
      });
      // ?fields= picks the fields, and keeps can and etag (which it can't name).
      const [picked] = (
        await a.agent.get('/v1/approvals?fields=title').expect(200)
      ).body.items;
      expect(Object.keys(picked).sort()).toEqual(
        ['can', 'etag', 'id', 'title'].sort(),
      );
      await a.agent.get('/v1/approvals?fields=etag').expect(400);

      // A row's etag is good as If-Match; once the request changed, it is stale (412).
      const stale = theirs!.etag;
      await delegate.agent
        .post(`/v1/approvals/${id}/approve`)
        .set('If-Match', (await inbox(delegate.agent))[0]!.etag)
        .send({})
        .expect(200);
      const refused = await a.agent
        .post(`/v1/approvals/${id}/approve`)
        .set('If-Match', stale)
        .send({})
        .expect(412);
      expect(refused.body.code).toBe('precondition_failed');
      const [fresh] = await inbox(a.agent, '?assignedToMe=true');
      expect(fresh!.etag).not.toBe(stale);
      await a.agent
        .post(`/v1/approvals/${id}/approve`)
        .set('If-Match', fresh!.etag)
        .send({})
        .expect(200);
      expect((await detail(requester.agent, id)).status).toBe('approved');
      // Ended, nothing is left to do with it; the tags still match the GET's.
      const [ended] = await inbox(a.agent);
      expect(ended!.can).toEqual({
        decide: false,
        cancel: false,
        resubmit: false,
        abandon: false,
      });
      expect(ended!.etag).toBe(
        (await a.agent.get(`/v1/approvals/${id}`).expect(200)).headers.etag,
      );
    });

    it('decidedByMe: what the caller decided, themselves or standing in for someone', async () => {
      const [requester, a, b, delegate] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({ stages: [stage([users(a, b)])] });
      const decided = await ask(requester, 'Decided by a');
      const waiting = await ask(requester, 'Waiting');
      const rejected = await ask(requester, 'Rejected by a');
      await approve(a, decided).expect(200);
      await a.agent
        .post(`/v1/approvals/${rejected}/reject`)
        .send({ comment: 'No.' })
        .expect(200);
      const now = Date.now();
      await b.agent
        .post('/v1/approvals/delegations')
        .send({
          toUserId: delegate.id,
          startsAt: new Date(now - 60_000).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
        })
        .expect(201);
      const forB = await ask(requester, 'Decided for b');
      await approve(delegate, forB).expect(200);

      expect(ids(await inbox(a.agent, '?decidedByMe=true'))).toEqual(
        [decided, rejected].sort(),
      );
      // The delegate's decision is theirs, not b's (b's assignment says onBehalfOf).
      expect(ids(await inbox(delegate.agent, '?decidedByMe=true'))).toEqual([
        forB,
      ]);
      expect(await inbox(b.agent, '?decidedByMe=true')).toEqual([]);
      expect(await inbox(requester.agent, '?decidedByMe=true')).toEqual([]);
      // false: what they take part in and didn't decide; with the other filters.
      expect(ids(await inbox(a.agent, '?decidedByMe=false'))).toEqual(
        [waiting, forB].sort(),
      );
      expect(
        ids(await inbox(a.agent, '?decidedByMe=true&status=rejected')),
      ).toEqual([rejected]);
      expect(
        ids(
          await inbox(
            a.agent,
            `?filter=${encodeURIComponent(JSON.stringify({ field: 'decidedByMe', op: 'eq', value: true }))}`,
          ),
        ),
      ).toEqual([decided, rejected].sort());
      // An API client decides nothing: nothing is decided by it.
      const client = await node.client();
      expect(
        (
          await node
            .http()
            .get('/v1/approvals?decidedByMe=true')
            .set('Authorization', client.auth)
            .expect(200)
        ).body.items,
      ).toEqual([]);
    });

    it('security: can and decidedByMe stay within what the reader may see, in their tenant', async () => {
      const [requester, a, stranger] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      await approve(a, id).expect(200);
      await ask(requester, 'Second');
      // A member who takes no part: neither filter value shows them anything.
      for (const query of [
        '',
        '?decidedByMe=true',
        '?decidedByMe=false',
        '?assignedToMe=false&requestedByMe=false&decidedByMe=false',
      ]) {
        expect(await inbox(stranger.agent, query)).toEqual([]);
      }
      // Another tenant's administrator (Approval.read, Approval.cancel there): nothing of this tenant's.
      const other = await node.otherTenant();
      for (const query of ['', '?decidedByMe=false', '?status=approved']) {
        expect(await inbox(other.admin, query)).toEqual([]);
      }
      const outsider = await other.user([]);
      expect(await inbox(outsider.agent, '?decidedByMe=false')).toEqual([]);
      await other.admin.get(`/v1/approvals/${id}`).expect(404);
      // An approver's can follows their role, not the list's filter: a decided
      // request is no longer theirs to decide, nor ever theirs to cancel.
      const [item] = await inbox(a.agent, '?decidedByMe=true');
      expect(item!.can).toEqual({
        decide: false,
        cancel: false,
        resubmit: false,
        abandon: false,
      });
      await a.agent.post(`/v1/approvals/${id}/cancel`).send({}).expect(403);
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

  describe('policies at runtime, and extensions', () => {
    it('validates an override against the registered types; a running request keeps its version', async () => {
      const admin = node.admin();
      const [requester, a, b] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      const code = await admin
        .get('/v1/approvals/policies/TestItem.publish')
        .expect(200);
      expect(code.body).toMatchObject({
        version: 0,
        source: 'code',
        setting: 'testItems.publishApproval',
      });
      expect(code.body.payloadSchema.properties.title).toBeDefined();

      const unknown = await admin
        .put('/v1/approvals/policies/TestItem.publish')
        .send({ stages: [stage([{ type: 'nope' }])] })
        .expect(400);
      expect(unknown.body.errors[0].path).toBe('stages.0.approvers.0.type');
      const badParams = await admin
        .put('/v1/approvals/policies/TestItem.publish')
        .send({
          stages: [stage([{ type: 'role' }], { mode: { type: 'quorum' } })],
        })
        .expect(400);
      expect(
        badParams.body.errors.map((e: { path: string }) => e.path).sort(),
      ).toEqual(['stages.0.approvers.0.role', 'stages.0.mode.n']);

      const v1 = await setPolicy({ stages: [stage([users(a)])] });
      expect(v1.body).toMatchObject({ version: 1, source: 'override' });
      const running = await ask(requester);
      await setPolicy({ stages: [stage([users(b)])] });
      // The running request keeps version 1's approver; a new one gets version 2's.
      expect(await detail(requester.agent, running)).toMatchObject({
        policyVersion: 1,
        assignments: [{ approverId: a.id }],
      });
      const next = await ask(requester);
      expect(await detail(requester.agent, next)).toMatchObject({
        policyVersion: 2,
        assignments: [{ approverId: b.id }],
      });

      // Off: no approval needed. Reset: the code's default again, as version 4.
      await setPolicy({ enabled: false, stages: [stage([users(a)])] });
      expect(
        await requestApproval(`user:${requester.id}`, {
          subject: 'TestItem',
          recordId: await aTestItem('x'),
          action: 'publish',
        }),
      ).toEqual({ required: false });
      const reset = await admin
        .delete('/v1/approvals/policies/TestItem.publish')
        .expect(200);
      expect(reset.body).toMatchObject({ version: 4, source: 'code' });
      const audit = await admin
        .get('/v1/access/audit?action=approvalPolicy.updated')
        .expect(200);
      expect(audit.body.items.length).toBeGreaterThanOrEqual(3);
    });

    it('takes an approver rule a project registers, and a condition on the payload', async () => {
      const [requester, picked] = [await node.user([]), await node.user([])];
      // A project's own rule, registered as any provider does it.
      node.app.get(ApprovalsRegistry).addRule({
        type: 'test-pick',
        label: 'The user the test picks',
        schema: z.object({ userId: z.uuid() }).strict(),
        resolve: async ({ params }) => [(params as { userId: string }).userId],
      });
      const types = await node
        .admin()
        .get('/v1/approvals/policy-types')
        .expect(200);
      expect(
        types.body.approverRules.map((rule: { type: string }) => rule.type),
      ).toEqual(
        expect.arrayContaining([
          'role',
          'teamRole',
          'permission',
          'users',
          'test-pick',
        ]),
      );
      await setPolicy({
        when: { type: 'payload', path: 'title', op: 'ne', value: 'trivial' },
        stages: [stage([{ type: 'test-pick', userId: picked.id }])],
      });
      const id = await ask(requester);
      expect((await detail(picked.agent, id)).assignments).toMatchObject([
        { approverId: picked.id, status: 'pending' },
      ]);
      // The condition: a trivial change needs no approval.
      expect(
        await requestApproval(`user:${requester.id}`, {
          subject: 'TestItem',
          recordId: await aTestItem('trivial'),
          action: 'publish',
        }),
      ).toEqual({ required: false });
    });

    it('resolves approvers by permission on the record', async () => {
      const owner = await node.user(['editor']);
      const viewer = await node.user(['viewer']);
      await node.user(['editor']); // may update only their own test items: not an approver
      await setPolicy({
        stages: [stage([{ type: 'permission', action: 'read' }])],
      });
      const testItem = await node.writeItem(owner.agent).expect(201);
      const result = await requestApproval(`user:${owner.id}`, {
        subject: 'TestItem',
        recordId: testItem.body.id,
        action: 'publish',
      });
      expect(result.required).toBe(true);
      await node.worker.drain();
      const approvers = (
        await detail(
          owner.agent,
          (result as { request: { id: string } }).request.id,
        )
      ).assignments.map((x: { approverId: string }) => x.approverId);
      // The viewer reads every testItem; the administrator may do anything.
      expect(approvers).toContain(viewer.id);
      expect(approvers).not.toContain(owner.id);
    });

    it('tells lifecycle listeners in the change’s transaction; a listener that throws refuses the change', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const heard: string[] = [];
      const record =
        (hook: string) =>
        async ({ request }: ApprovalLifecycleEvent) => {
          heard.push(`${hook}:${request.status}`);
        };
      const registry = node.app.get(ApprovalsRegistry);
      registry.listen({
        subjects: ['TestItem'],
        requested: record('requested'),
        stageStarted: record('stageStarted'),
        assigned: record('assigned'),
        decided: record('decided'),
        approved: record('approved'),
      });
      registry.listen({ subjects: ['Invoice'], requested: record('never') });
      const id = await ask(requester);
      await approve(a, id).expect(200);
      expect(heard).toEqual([
        'requested:pending',
        'assigned:pending',
        'stageStarted:pending',
        'decided:pending',
        'approved:approved',
      ]);

      // An extra check: a listener refuses requests over a limit, and nothing is written.
      registry.listen({
        requested: async ({ request }) => {
          if (request.payload.title === 'refused') {
            throw new Error('over the limit');
          }
        },
      });
      await expect(
        requestApproval(`user:${requester.id}`, {
          subject: 'TestItem',
          recordId: await aTestItem('refused'),
          action: 'publish',
        }),
      ).rejects.toThrow('over the limit');
      expect(
        (
          await requester.agent
            .get('/v1/approvals?requestedByMe=true')
            .expect(200)
        ).body.items,
      ).toHaveLength(1);
    });

    it('sends the requesting API client its webhooks and realtime events', async () => {
      const receiver = await webhookReceiver();
      try {
        const [client, a] = [await node.client(), await node.user([])];
        await node
          .http()
          .post('/v1/webhook-endpoints')
          .set('Authorization', client.auth)
          .send({
            url: receiver.url,
            eventTypes: ['approval.requested', 'approval.approved'],
          })
          .expect(201);
        const socket = await connect(node, client.key);
        const decided = new Promise<unknown>((resolve) =>
          socket.once('approval.decided', resolve),
        );
        await setPolicy({ stages: [stage([users(a)])] });
        const result = await requestApproval(`client:${client.id}`, {
          subject: 'TestItem',
          recordId: await aTestItem('From a system'),
          action: 'publish',
        });
        const id = (result as { request: { id: string } }).request.id;
        await node.worker.drain();
        const assigned = await detail(a.agent, id);
        expect(assigned.requesterName).toMatch(/^client-/);
        await approve(a, id).expect(200);
        expect(await decided).toEqual({
          id,
          status: 'approved',
          round: 0,
          stage: 0,
          decision: 'approved',
        });
        await node.worker.drain();
        await node.deliverWebhooks();
        expect(receiver.received.map((hook) => hook.body.type)).toEqual([
          'approval.requested',
          'approval.approved',
        ]);
        expect(receiver.received[1]!.body.data).toMatchObject({
          requestId: id,
          subject: 'TestItem',
          action: 'publish',
          status: 'approved',
        });
        socket.disconnect();
      } finally {
        await receiver.close();
      }
    });

    it('exports a person’s requests and decisions; their deletion keeps them without the names', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      await approve(a, id, { comment: 'Yes.' }).expect(200);
      const person = (user: User) =>
        ({ kind: 'user', id: user.id }) as UserPrincipal;
      // In the tenant, as the account export reads each of the person's.
      const exported = (user: User) =>
        node.inTenant(async () => {
          const rows: Record<string, unknown>[] = [];
          for await (const batch of service().rows(person(user))) {
            rows.push(...batch);
          }
          return rows;
        });
      expect(await exported(requester)).toMatchObject([
        { id, kind: 'request', status: 'approved' },
      ]);
      expect(await exported(a)).toMatchObject([
        {
          kind: 'decision',
          requestId: id,
          decision: 'approved',
          comment: 'Yes.',
        },
      ]);

      await erase(person(a));
      await erase(person(requester));
      const shown = await detail(node.admin(), id);
      expect(shown.requesterName).toBe('Deleted user');
      expect(shown.assignments[0]).toMatchObject({
        status: 'approved',
        decidedByName: 'Deleted user',
      });
      expect(
        shown.timeline
          .filter((event: { actor: string }) => event.actor.startsWith('user:'))
          .map((event: { actorName: string }) => event.actorName),
      ).toEqual(['Deleted user', 'Deleted user', 'Deleted user']);
    });

    it('reports open and overdue requests on /metrics', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)], { dueAfter: '1h' })] });
      const id = await ask(requester);
      const scrape = async () =>
        (
          await node
            .http()
            .get('/metrics')
            .set('Authorization', `Bearer ${METRICS}`)
            .expect(200)
        ).text;
      expect(await scrape()).toMatch(/^approvals_open\{status="pending"\} 1$/m);
      expect(await scrape()).toMatch(/^approvals_overdue_seconds 0$/m);
      // Its deadline 20 minutes gone, and no workflow ran it (as with no worker).
      const db = node.db;
      await db
        .update(approvalRequests)
        // PostgreSQL's clock, as the gauge reads it: Node's may differ by a
        // few milliseconds (a VM's clock), which made this 1199.999.
        .set({ dueAt: sql`now() - interval '20 minutes'` })
        .where(eq(approvalRequests.id, id));
      const overdue = Number(
        /^approvals_overdue_seconds (\S+)$/m.exec(await scrape())![1],
      );
      expect(overdue).toBeGreaterThanOrEqual(1200);
      expect(overdue).toBeLessThan(1300);
    });

    it('refuses a second open request for the same action on the record (409)', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const recordId = await aTestItem();
      const input = {
        subject: 'TestItem',
        recordId,
        action: 'publish',
      };
      await requestApproval(`user:${requester.id}`, input);
      await expect(
        requestApproval(`user:${requester.id}`, input),
      ).rejects.toMatchObject({ response: { code: 'approval_pending' } });
      // The same idempotency key is the same request.
      const keyed = {
        ...input,
        recordId: await aTestItem(),
        idempotencyKey: randomUUID(),
      };
      const once = await requestApproval(`user:${requester.id}`, keyed);
      const twice = await requestApproval(`user:${requester.id}`, keyed);
      expect((twice as { request: { id: string } }).request.id).toBe(
        (once as { request: { id: string } }).request.id,
      );
    });
  });
  describe('steps that run twice (a retry after an attempt that committed)', () => {
    const engine = () => node.app.get(ApprovalEngine);
    /** A step called by hand, as the workflow runs it: as `system:approvals`. */
    const asSystem = <T>(work: () => Promise<T>) =>
      node.app.get(SystemContext).run(APPROVALS_JOB, work, {
        transaction: false,
        tenantId: node.tenantId,
      });

    it('answers what the first attempt did: escalated, expired, failed', async () => {
      const [requester, a, boss, x] = [
        await node.user([]),
        await node.user([]),
        await node.user([]),
        await node.user([]),
      ];
      // An escalation, twice: still escalated, not expired.
      await setPolicy({
        stages: [
          stage([users(a)], {
            dueAfter: '1d',
            onOverdue: 'escalate',
            escalateTo: [users(boss)],
            escalationDueAfter: '1d',
          }),
        ],
      });
      const escalating = await ask(requester);
      expect([
        await asSystem(() => engine().overdue(escalating, 0, 0)),
        await asSystem(() => engine().overdue(escalating, 0, 0)),
      ]).toEqual(['escalated', 'escalated']);
      expect((await detail(requester.agent, escalating)).status).toBe(
        'pending',
      );
      // Its deadline after the escalation, twice: expired both times.
      expect([
        await asSystem(() => engine().expireStage(escalating, 0, 0)),
        await asSystem(() => engine().expireStage(escalating, 0, 0)),
      ]).toEqual(['expired', 'expired']);

      // An expiry, twice: expired, not "raced" (which waited for ever).
      await setPolicy({ stages: [stage([users(a)], { dueAfter: '1d' })] });
      const expiring = await ask(requester);
      expect([
        await asSystem(() => engine().overdue(expiring, 0, 0)),
        await asSystem(() => engine().overdue(expiring, 0, 0)),
      ]).toEqual(['expired', 'expired']);

      // A resubmission that never came, twice.
      await setPolicy({ stages: [stage([users(a)])] });
      const sentBack = await ask(requester);
      await a.agent
        .post(`/v1/approvals/${sentBack}/request-changes`)
        .send({ comment: 'More.' })
        .expect(200);
      expect([
        await asSystem(() => engine().expireResubmission(sentBack, 0)),
        await asSystem(() => engine().expireResubmission(sentBack, 0)),
      ]).toEqual(['expired', 'expired']);

      // A stage that finds nobody, twice: failed (and concluded as failed), not cancelled.
      await setPolicy({ stages: [stage([users(x)])] });
      // Made while x is active; x goes before the stage starts.
      const made = await requestApproval(`user:${requester.id}`, {
        subject: 'TestItem',
        recordId: await aTestItem(),
        action: 'publish',
      });
      const failing = (made as { request: { id: string } }).request.id;
      await node
        .admin()
        .patch(`/v1/access/users/${x.id}`)
        .send({ active: false })
        .expect(204);
      expect([
        await asSystem(() => engine().startStage(failing, 0, 0)),
        await asSystem(() => engine().startStage(failing, 0, 0)),
      ]).toEqual(['failed', 'failed']);
      await node.worker.drain(); // the workflow's own start step: failed too, concluded as such
      expect(
        (await node.workflows.getStatus(approvalWorkflowId(failing)))?.output,
      ).toEqual({ status: 'failed' });
    });

    it('a workflow whose step committed, then failed, concludes with what it did', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)], { dueAfter: '1d' })] });
      const id = await ask(requester);
      const original = engine().overdue.bind(engine());
      const step = vi
        .spyOn(engine(), 'overdue')
        .mockImplementationOnce(async (...args) => {
          await original(...args); // committed…
          throw new Error('the worker died before the journal'); // …but not journaled
        });
      node.clock.advance('1d');
      await node.worker.drain(); // the attempt fails after its commit
      node.clock.advance('5s'); // the step's backoff
      await node.worker.drain(); // the retry finds the request expired
      expect(step).toHaveBeenCalledTimes(2);
      expect(
        await node.workflows.getStatus(approvalWorkflowId(id)),
      ).toMatchObject({ status: 'completed', output: { status: 'expired' } });
      expect((await detail(requester.agent, id)).outcomeReason).toBe('overdue');
    });
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

  describe('deactivation is never refused', () => {
    it('N3: a failing listener doesn’t stop an account being deactivated; locks go in request order', async () => {
      const [requester, a] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(a)])] });
      const id = await ask(requester);
      // Scoped to this request: no other test (or request) meets it.
      node.app.get(ApprovalsRegistry).listen({
        failed: async ({ request }) => {
          if (request.id === id) {
            throw new Error('a listener that breaks');
          }
        },
      });
      await node
        .admin()
        .patch(`/v1/access/users/${a.id}`)
        .send({ active: false })
        .expect(204);
      expect(await detail(requester.agent, id)).toMatchObject({
        status: 'failed',
        outcomeReason: 'no_approvers',
      });
      // Several requests are locked in one order (by id) by every deactivation and deletion.
      const db = node.db;
      const query = node.app
        .get(ApprovalEngine)
        .pendingRequestsOf(db, a.id)
        .toSQL().sql;
      expect(query).toMatch(/order by "approval_assignments"\."request_id"/);
    });

    it('N3: a failing notification doesn’t stop it either', async () => {
      const [requester, b] = [await node.user([]), await node.user([])];
      await setPolicy({ stages: [stage([users(b)])] });
      const id = await ask(requester);
      vi.spyOn(
        node.app.get(NotificationsService),
        'notify',
      ).mockRejectedValueOnce(new Error('the notifications table is gone'));
      await node
        .admin()
        .patch(`/v1/access/users/${b.id}`)
        .send({ active: false })
        .expect(204);
      expect((await detail(requester.agent, id)).status).toBe('failed');
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
