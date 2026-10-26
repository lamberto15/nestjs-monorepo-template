import type { UserPrincipal } from '../src/iam/auth/principal.js';
import { SystemContext } from '../src/iam/access/system-context.js';
import { ACCOUNT_DELETION_JOB } from '../src/platform/platform.jobs.js';
import { TEST_ITEM_PUBLICATION_JOB } from './fixtures/test-items/test-item.policy.js';
import type request from 'supertest';
import { ApprovalsService } from '../src/platform/approvals/approvals.service.js';
import { bootApp, type TestApp } from './support.js';

/** A person signed in during a test: the id and the agent that carries their session. */
export type User = { id: string; agent: request.Agent };

/**
 * The shared setup of the approvals e2e specs, split over several files so
 * they run on separate workers. Call it inside a file's `describe`: it boots a
 * fresh app before every test (the example action, TestItem.publish, needs
 * approval only with its flag on) and closes it after, and returns the helpers
 * over that app. `node` is a getter: the app is replaced for every test.
 */
export function approvalsHarness() {
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

  /** A write to the test item, refused while its approval is pending (409 `approval_pending`). */
  async function refusedWhilePending(
    user: User,
    testItem: string,
    title: string,
  ) {
    const refused = await user.agent
      .patch(`/v1/test-items/${testItem}`)
      .send({ title })
      .expect(409);
    expect(refused.body.code).toBe('approval_pending');
  }

  /** The test item once its approved outcome is applied: published, with this title. */
  async function publishedAs(user: User, testItem: string, title: string) {
    const read = await user.agent.get(`/v1/test-items/${testItem}`).expect(200);
    expect(read.body).toMatchObject({ publishedAt: expect.any(String), title });
  }

  return {
    get node() {
      return node;
    },
    service,
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
    refusedWhilePending,
    publishedAs,
  };
}
