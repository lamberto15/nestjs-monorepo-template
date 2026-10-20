import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { StorageDisk } from '@nestjs/storage';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type request from 'supertest';
import { tenants } from '../src/core/tenancy/tenancy.tables.js';
import { TenantDeletionJob } from '../src/iam/access/tenant-deletion.job.js';
import { memberships } from '../src/iam/iam.tables.js';
import { ApprovalWorkflow } from '../src/platform/approvals/approval.workflow.js';
import { DATA_TRANSFERS } from '../src/platform/data-transfer/data-transfer.service.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { bootApp, type TestApp } from './support.js';

/** A signed URL's path and query, for this app (its host is APP_URL's). */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

type Row = { kind: string; id: string | null; data: Record<string, any> };

const DAY = 86_400_000;

/**
 * A tenant's export and deletion, the operators' (docs/tenancy.md,
 * "Exporting a tenant", "Deleting a tenant"): the export holds that
 * tenant's rows and no other's, behind a link that expires; the deletion
 * deactivates, waits its grace period (cancellable), then a worker erases
 * the rows, the files, the queued jobs and the workflows, audited outside
 * any tenant. The refusals (operators only, step-up) are in
 * security.e2e-spec.ts.
 */
describe('tenant export and deletion (e2e)', () => {
  let node: TestApp;
  let other: Awaited<ReturnType<TestApp['otherTenant']>>;

  beforeEach(async () => {
    node = await bootApp();
    other = await node.otherTenant();
  });
  afterEach(() => node.close());

  /** The operator exports a tenant, waits for it: its status and file. */
  async function exportOf(
    tenantId: string,
    agent: request.Agent = node.admin(),
  ) {
    const key = randomUUID();
    const started = await agent
      .post(`/v1/tenants/${tenantId}/export`)
      .set('Idempotency-Key', key)
      .send({})
      .expect(202);
    const id = started.body.id as string;
    // The same key replays the first answer: one export, not two.
    const replay = await agent
      .post(`/v1/tenants/${tenantId}/export`)
      .set('Idempotency-Key', key)
      .send({})
      .expect(202);
    expect(replay.body.id).toBe(id);
    let status: Record<string, any> = {};
    for (let tries = 0; tries < 200; tries++) {
      status = (await agent.get(`/v1/data/transfers/${id}`).expect(200)).body;
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status.status).toBe('completed');
    const file = (await node.http().get(local(status.result.url)).expect(200))
      .body as Row[];
    return { id, status, file };
  }

  it("exports every record of one tenant and none of another's, behind a link that expires", async () => {
    const mine = await node
      .writeItem(other.admin, { title: 'Theirs', body: 'x' })
      .expect(201);
    const client = await other.client();
    const third = await node.otherTenant();
    const foreign = await node
      .writeItem(third.admin, { title: 'Not theirs', body: 'y' })
      .expect(201);

    const { id, status, file } = await exportOf(other.id);
    // The operators' file, under their tenant (it outlives the exported one).
    expect(decodeURIComponent(status.result.url)).toContain(
      `tenants/${node.tenantId}/transfers/`,
    );
    expect(file[0]).toMatchObject({ kind: 'tenant', id: other.id });
    expect(file.find((row) => row.kind === 'member')?.data.email).toBe(
      other.email,
    );
    expect(
      file.find((row) => row.kind === 'test_items' && row.id === mine.body.id)
        ?.data.title,
    ).toBe('Theirs');
    // Its client and its key, without the key's hash.
    expect(
      file.some((row) => row.kind === 'api_clients' && row.id === client.id),
    ).toBe(true);
    const key = file.find((row) => row.kind === 'api_keys');
    expect(key).toBeDefined();
    expect(key!.data).not.toHaveProperty('keyHash');
    // Nothing of another tenant, nor of none.
    expect(file.some((row) => row.id === foreign.body.id)).toBe(false);
    for (const row of file) {
      if ('tenantId' in row.data) {
        expect(row.data.tenantId, row.kind).toBe(other.id);
      }
    }

    // The link works for 30 minutes, then no more.
    const expires = Number(
      new URL(status.result.url).searchParams.get('expires'),
    );
    expect(expires * 1000).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);
    const later = Date.now() + 31 * 60_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const expired = await node.http().get(local(status.result.url));
      expect(expired.status).toBeGreaterThanOrEqual(400);
    } finally {
      now.mockRestore();
    }

    // Audited in both tenants; the transfer itself in the operators'.
    const entries = await node.auditEntries({
      action: 'tenant.export-requested',
      targetId: other.id,
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.tenantId)).toEqual(
      expect.arrayContaining([node.tenantId, other.id]),
    );
    expect(entries[0]!.details).toMatchObject({ transferId: id });
    const [done] = await node.auditEntries({
      action: 'data.exported',
      targetId: id,
    });
    expect(done!.tenantId).toBe(node.tenantId);
  });

  it('deactivates at once, waits its grace period, and can be cancelled until then', async () => {
    // The slug confirms it.
    await node
      .admin()
      .post(`/v1/tenants/${other.id}/deletion`)
      .send({ slug: 'not-it' })
      .expect(400)
      .expect(({ body }) =>
        expect(body.errors).toEqual([
          expect.objectContaining({ path: 'slug' }),
        ]),
      );
    const before = Date.now();
    const requested = await node
      .admin()
      .post(`/v1/tenants/${other.id}/deletion`)
      .send({ slug: other.slug })
      .expect(200);
    expect(requested.body).toMatchObject({ active: false });
    const scheduledFor = Date.parse(requested.body.deletionScheduledFor);
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 30 * DAY - 1000);
    expect(scheduledFor).toBeLessThanOrEqual(Date.now() + 30 * DAY + 1000);
    // Deactivated: its sessions end.
    await other.admin.get('/v1/auth/me').expect(401);
    // Asked again: the same, nothing scheduled twice.
    const again = await node
      .admin()
      .post(`/v1/tenants/${other.id}/deletion`)
      .send({ slug: other.slug })
      .expect(200);
    expect(again.body.deletionScheduledFor).toBe(
      requested.body.deletionScheduledFor,
    );
    const entries = await node.auditEntries({
      action: 'tenant.deletion-requested',
      targetId: other.id,
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.tenantId)).toEqual(
      expect.arrayContaining([node.tenantId, other.id]),
    );
    // Not back while its deletion is pending.
    await node
      .admin()
      .patch(`/v1/tenants/${other.id}`)
      .send({ active: true })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('tenant_deletion_pending'));

    // Before the grace period ends, the job leaves it.
    const job = node.app.get(TenantDeletionJob);
    expect(await job.run(new Date(Date.now() + 29 * DAY))).toBe(0);
    await node.admin().get(`/v1/tenants/${other.id}`).expect(200);

    const cancelled = await node
      .admin()
      .delete(`/v1/tenants/${other.id}/deletion`)
      .expect(200);
    expect(cancelled.body).toMatchObject({
      active: false,
      deletionScheduledFor: null,
    });
    await node.admin().delete(`/v1/tenants/${other.id}/deletion`).expect(404);
    expect(
      await node.auditEntries({
        action: 'tenant.deletion-cancelled',
        targetId: other.id,
      }),
    ).toHaveLength(2);
    // Cancelled: the job never erases it, and it can come back.
    expect(await job.run(new Date(Date.now() + 31 * DAY))).toBe(0);
    await node
      .admin()
      .patch(`/v1/tenants/${other.id}`)
      .send({ active: true })
      .expect(200);
    await node.signIn(other.email, other.password);
  });

  it('erases its rows, its files, its jobs and its workflows after the grace period, audited outside any tenant', async () => {
    const item = await node
      .writeItem(other.admin, { title: 'Going', body: 'x' })
      .expect(201);
    const third = await node.otherTenant();
    const kept = await node
      .writeItem(third.admin, { title: 'Staying', body: 'y' })
      .expect(201);

    const disk = node.app.get(StorageDisk);
    const theirs = `tenants/${other.id}/attachments/${randomUUID()}.txt`;
    const notTheirs = `tenants/${third.id}/attachments/${randomUUID()}.txt`;
    await disk.put(theirs, Buffer.from('theirs'));
    await disk.put(notTheirs, Buffer.from('not theirs'));

    const queue = node.app.get<Queue>(getQueueToken(DATA_TRANSFERS), {
      strict: false,
    });
    const queued = await queue.add('export', { tenantId: other.id } as never, {
      delay: 3_600_000,
    });
    const otherQueued = await queue.add(
      'export',
      { tenantId: third.id } as never,
      { delay: 3_600_000 },
    );
    // The test app runs no workflow worker: the instance stays pending.
    const workflow = await node.workflows.start(ApprovalWorkflow, {
      requestId: randomUUID(),
      tenantId: other.id,
    });

    await node
      .admin()
      .post(`/v1/tenants/${other.id}/deletion`)
      .send({ slug: other.slug })
      .expect(200);
    const job = node.app.get(TenantDeletionJob);
    expect(await job.run(new Date(Date.now() + 31 * DAY))).toBe(1);

    await node.admin().get(`/v1/tenants/${other.id}`).expect(404);
    const db = node.db;
    expect(
      await db.select().from(tenants).where(eq(tenants.id, other.id)),
    ).toEqual([]);
    expect(
      await db.select().from(testItems).where(eq(testItems.tenantId, other.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(memberships)
        .where(eq(memberships.tenantId, other.id)),
    ).toEqual([]);
    expect(
      await db.select().from(testItems).where(eq(testItems.id, kept.body.id)),
    ).toHaveLength(1);
    expect(item.body.id).not.toBe(kept.body.id);

    expect(await disk.exists(theirs)).toBe(false);
    expect(await disk.exists(notTheirs)).toBe(true);
    expect(await queue.getJob(queued.id!)).toBeUndefined();
    expect(await queue.getJob(otherQueued.id!)).toBeDefined();
    expect(await node.workflows.getStatus(workflow.id)).toBeNull();

    // The tenant's own log went with it; the entry is outside any tenant.
    const [purged] = await node.auditEntries({
      action: 'tenant.purged',
      targetId: other.id,
    });
    expect(purged).toMatchObject({
      tenantId: null,
      actor: 'system:tenant-deletion',
    });
    expect(purged!.details).toMatchObject({
      slug: other.slug,
      reason: 'deletion',
    });
    expect(
      await node.auditEntries({
        action: 'tenant.deletion-requested',
        targetId: other.id,
      }),
    ).toHaveLength(1); // the operators', in their tenant
    // The account stays, in no tenant.
    const back = await node.signIn(other.email, other.password);
    expect((await back.get('/v1/auth/me').expect(200)).body.tenant).toBeNull();
    // Nothing left to run: the next night erases nothing.
    expect(await job.run(new Date(Date.now() + 32 * DAY))).toBe(0);
  });

  it('never deletes the operator tenant', async () => {
    const operators = (
      await node.admin().get(`/v1/tenants/${node.tenantId}`).expect(200)
    ).body as { slug: string };
    await node
      .admin()
      .post(`/v1/tenants/${node.tenantId}/deletion`)
      .send({ slug: operators.slug })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('operator_tenant'));
    expect(
      await node.app
        .get(TenantDeletionJob)
        .run(new Date(Date.now() + 365 * DAY)),
    ).toBe(0);
    await node.admin().get('/v1/auth/me').expect(200);
  });
});
