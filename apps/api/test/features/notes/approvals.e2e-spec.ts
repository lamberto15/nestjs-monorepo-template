import { SystemContext } from '../../../src/iam/access/system-context.js';
import { ApprovalsService } from '../../../src/platform/approvals/approvals.service.js';
import { NOTE_PUBLICATION_JOB } from '../../../src/features/notes/note.policy.js';
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

/**
 * What is notes' own about approvals: publishing a note goes through the
 * approval of Note.publish (note-approvals.ts) and the publication
 * workflow. The engine itself (stages, modes, who decides, delegation,
 * escalation, time, security) is tested on the test-only record: test/approvals.e2e-spec.ts.
 */
describe('approvals of notes (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
    // Note.publish needs approval only with its flag on.
    await node
      .admin()
      .put('/v1/settings/notes.publishApproval')
      .send({ value: true })
      .expect(200);
  });

  afterEach(async () => {
    await node.close();
  });

  const service = () => node.app.get(ApprovalsService);

  /** Asks for approval on a person's behalf, as the publication workflow does: inside its system job. */
  const requestApproval = (...args: Parameters<ApprovalsService['request']>) =>
    node.app
      .get(SystemContext)
      .run(NOTE_PUBLICATION_JOB, () => service().request(...args), {
        transaction: false,
        tenantId: node.tenantId,
      });

  const detail = async (agent: ReturnType<TestApp['admin']>, id: string) =>
    (await agent.get(`/v1/approvals/${id}`).expect(200)).body;

  const types = async (agent: ReturnType<TestApp['admin']>) =>
    (
      (await agent.get('/v1/notifications').expect(200)).body.items as {
        type: string;
      }[]
    ).map((item) => item.type);

  const approve = (
    user: { agent: ReturnType<TestApp['admin']> },
    id: string,
    body: Record<string, unknown> = {},
  ) => user.agent.post(`/v1/approvals/${id}/approve`).send(body);

  describe('the notes example, end to end', () => {
    it('asks an editor before publishing, refuses edits meanwhile, publishes once approved', async () => {
      const owner = await node.user(['editor']);
      const editor = await node.user(['editor']);
      const note = await writeNote(node, owner.agent).expect(201);
      await node.worker.drain();
      node.clock.advance('10s'); // the publication delay
      await node.worker.drain(); // the publication asks; the approval assigns the editors

      expect(
        (await node.workflows.getStatus(`note-${note.body.id}`))?.customStatus,
      ).toBe('awaiting-approval');
      const inbox = await editor.agent
        .get('/v1/approvals?assignedToMe=true')
        .expect(200);
      expect(inbox.body.items).toHaveLength(1);
      const [item] = inbox.body.items;
      expect(item).toMatchObject({
        key: 'Note.publish',
        recordId: note.body.id,
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

      // While the editors decide, the note doesn't change.
      const refused = await owner.agent
        .patch(`/v1/notes/${note.body.id}`)
        .send({ title: 'Changed' })
        .expect(409);
      expect(refused.body).toMatchObject({
        code: 'approval_pending',
        approvalId: item.id,
      });
      await owner.agent.delete(`/v1/notes/${note.body.id}`).expect(409);

      await approve(editor, item.id, { comment: 'Fine.' }).expect(200);
      await node.worker.drain(); // the outcome's handler publishes
      const published = await owner.agent
        .get(`/v1/notes/${note.body.id}`)
        .expect(200);
      expect(published.body.status).toBe('published');
      const done = await detail(owner.agent, item.id);
      expect(done).toMatchObject({ status: 'approved', outcomeReason: null });
      expect(
        done.timeline.map((event: { type: string }) => event.type),
      ).toEqual(['requested', 'stage_started', 'decided', 'approved']);
      expect(await types(owner.agent)).toContain('approval.approved');
      expect(await types(editor.agent)).toContain('approval.requested');
    });

    it('needs no approval while notes.publishApproval is off: the note publishes as before', async () => {
      await node
        .admin()
        .put('/v1/settings/notes.publishApproval')
        .send({ value: false })
        .expect(200);
      const owner = await node.user(['editor']);
      await node.user(['editor']);
      const note = await writeNote(node, owner.agent).expect(201);
      await node.worker.drain();
      node.clock.advance('10s');
      await node.worker.drain();
      expect(
        (await owner.agent.get(`/v1/notes/${note.body.id}`).expect(200)).body
          .status,
      ).toBe('published');
      const result = await requestApproval(`user:${owner.id}`, {
        subject: 'Note',
        recordId: note.body.id,
        action: 'publish',
      });
      expect(result).toEqual({ required: false });
    });
  });
});
