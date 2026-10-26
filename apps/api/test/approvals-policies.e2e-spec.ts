import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { UserPrincipal } from '../src/iam/auth/principal.js';
import { SystemContext } from '../src/iam/access/system-context.js';
import { APPROVALS_JOB } from '../src/platform/platform.jobs.js';
import { z } from 'zod';
import type request from 'supertest';
import { ApprovalsRegistry } from '../src/platform/approvals/approvals.registry.js';
import { approvalWorkflowId } from '../src/platform/approvals/approval-events.js';
import type { ApprovalLifecycleEvent } from '../src/platform/approvals/approval.types.js';
import { approvalRequests } from '../src/platform/approvals/approvals.tables.js';
import { ApprovalEngine } from '../src/platform/approvals/approval-engine.service.js';
import { NotificationsService } from '../src/platform/notifications/notifications.service.js';
import { connect, type TestApp, webhookReceiver } from './support.js';
import { approvalsHarness, type User } from './approvals.support.js';

// /metrics answers with a token only, read when AppModule loads (before the imports run).
const METRICS = vi.hoisted(() => {
  const token = 'metrics-token-for-the-approvals-tests';
  process.env.METRICS_TOKEN = token;
  return token;
});

describe('approvals (e2e)', () => {
  const harness = approvalsHarness();
  const {
    service,
    requestApproval,
    erase,
    setPolicy,
    stage,
    users,
    aTestItem,
    ask,
    detail,
    approve,
  } = harness;
  let node: TestApp;

  beforeEach(() => {
    node = harness.node;
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
    const ids = (items: Item[]) =>
      items.map((item) => item.id).sort((a, b) => a.localeCompare(b));

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
      expect(Object.keys(picked).sort((a, b) => a.localeCompare(b))).toEqual(
        ['can', 'etag', 'id', 'title'].sort((a, b) => a.localeCompare(b)),
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
        [decided, rejected].sort((a, b) => a.localeCompare(b)),
      );
      // The delegate's decision is theirs, not b's (b's assignment says onBehalfOf).
      expect(ids(await inbox(delegate.agent, '?decidedByMe=true'))).toEqual([
        forB,
      ]);
      expect(await inbox(b.agent, '?decidedByMe=true')).toEqual([]);
      expect(await inbox(requester.agent, '?decidedByMe=true')).toEqual([]);
      // false: what they take part in and didn't decide; with the other filters.
      expect(ids(await inbox(a.agent, '?decidedByMe=false'))).toEqual(
        [waiting, forB].sort((a, b) => a.localeCompare(b)),
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
      ).toEqual([decided, rejected].sort((a, b) => a.localeCompare(b)));
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
});
