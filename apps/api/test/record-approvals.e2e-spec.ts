import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

/**
 * What a record declares as `approvals` and `settings` (record.ts), on the
 * test-only record (test/fixtures/test-items): the settings and the approval's
 * flag are declared from it, `POST /v1/test-items/{id}/archive` asks for
 * the approval or applies the action at once, the record waits while a
 * request is open, and the effect (test-item.approvals.ts) runs once approved.
 */
describe('a record that declares approvals and settings (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const aTestItem = async () =>
    (await node.writeItem(node.admin(), { title: 'Q3 report' }).expect(201))
      .body.id as string;
  const archive = (id: string) =>
    node
      .admin()
      .post(`/v1/test-items/${id}/archive`)
      .set('Idempotency-Key', randomUUID());

  it('declares its settings under <path>.<name>, checked by their kinds', async () => {
    const admin = node.admin();
    const listed = (await admin.get('/v1/settings').expect(200)).body.items as {
      key: string;
    }[];
    const keys = listed.map((item) => item.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'testItems.archiveAfterDays',
        'testItems.autoArchive',
        'testItems.sortBy',
        'testItems.archiveApproval',
      ]),
    );
    expect(
      (await admin.get('/v1/settings/testItems.archiveAfterDays').expect(200))
        .body,
    ).toMatchObject({
      value: 90,
      type: 'number',
      integer: true,
      min: 1,
      max: 365,
    });
    expect(
      (await admin.get('/v1/settings/testItems.sortBy').expect(200)).body,
    ).toMatchObject({
      value: 'createdAt',
      type: 'enum',
      options: ['title', 'createdAt'],
    });
    await admin
      .put('/v1/settings/testItems.archiveAfterDays')
      .send({ value: 0 })
      .expect(400);
    await admin
      .put('/v1/settings/testItems.sortBy')
      .send({ value: 'size' })
      .expect(400);
    await admin
      .put('/v1/settings/testItems.archiveAfterDays')
      .send({ value: 30 })
      .expect(200);
    expect(
      (await admin.get('/v1/settings/testItems.archiveAfterDays').expect(200))
        .body,
    ).toMatchObject({ value: 30, source: 'tenant' });
  });

  it('applies the action at once while its approval is off', async () => {
    const id = await aTestItem();
    const done = await archive(id).expect(200);
    expect(done.body).toEqual({ status: 'applied', approvalId: null });
    const shown = await node.admin().get(`/v1/test-items/${id}`).expect(200);
    expect(shown.body.body).toBe('archived');
  });

  it('asks for approval once its flag is on: the record waits, then the effect runs', async () => {
    const admin = node.admin();
    await admin
      .put('/v1/settings/testItems.archiveApproval')
      .send({ value: true })
      .expect(200);
    // Editors decide (the default policy names whoever may update the record).
    await admin
      .put('/v1/approvals/policies/TestItem.archive')
      .send({
        stages: [
          {
            name: 'Review',
            approvers: [{ type: 'role', role: 'editor' }],
            mode: { type: 'any' },
          },
        ],
      })
      .expect(200);
    const editor = await node.user(['editor']);
    const id = await aTestItem();

    const asked = await archive(id).expect(202);
    expect(asked.body).toMatchObject({ status: 'pending' });
    const approvalId = asked.body.approvalId as string;
    await node.worker.drain(); // the approval assigns the editors

    // Not again, and not changed or deleted meanwhile.
    await archive(id).expect(409);
    await admin
      .patch(`/v1/test-items/${id}`)
      .set('If-Match', (await admin.get(`/v1/test-items/${id}`)).headers.etag)
      .send({ title: 'Changed' })
      .expect(409);
    await admin.delete(`/v1/test-items/${id}`).expect(409);

    await editor.agent
      .post(`/v1/approvals/${approvalId}/approve`)
      .send({})
      .expect(200);
    await node.worker.drain(); // the outcome's handler archives it
    const shown = await admin.get(`/v1/test-items/${id}`).expect(200);
    expect(shown.body.body).toBe('archived');
    expect(
      (await admin.get(`/v1/approvals/${approvalId}`).expect(200)).body.status,
    ).toBe('approved');
  });

  it('can be deleted again once the request is cancelled', async () => {
    const admin = node.admin();
    await admin
      .put('/v1/settings/testItems.archiveApproval')
      .send({ value: true })
      .expect(200);
    const id = await aTestItem();
    const approvalId = (await archive(id).expect(202)).body
      .approvalId as string;
    // The requester cancels: the record is theirs to change again.
    await admin.post(`/v1/approvals/${approvalId}/cancel`).send({}).expect(200);
    await admin.delete(`/v1/test-items/${id}`).expect(204);
  });

  it('asks only those who may update the record', async () => {
    const viewer = await node.user(['viewer']);
    const id = await aTestItem();
    await viewer.agent
      .post(`/v1/test-items/${id}/archive`)
      .set('Idempotency-Key', randomUUID())
      .expect(403);
  });
});
