import { randomUUID } from 'node:crypto';
import { eq, inArray, or } from 'drizzle-orm';
import { Client } from 'pg';
import { Tenancy } from '../src/core/tenancy/tenancy.service.js';
import { tenantClosure } from '../src/core/tenancy/tenancy.tables.js';
import { consolidatedScope } from '../src/core/tenancy/tenant-scope.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { Database } from '../src/core/database/drizzle.js';
import { bootApp, type TestApp } from './support.js';

type Other = Awaited<ReturnType<TestApp['otherTenant']>>;

/**
 * The tenant tree of holding groups (docs/tenancy.md, "The tenant tree"):
 * the operators place tenants (`parentId`, the closure kept with it, a
 * cycle refused); the read policies let a tenant read its descendants, and
 * only when `app.read_tenants` opts in (a consolidated read), never its
 * parent or a sibling whatever the setting says; and the consolidated audit
 * log over HTTP, gated by `Access.readConsolidated`, read-only, audited.
 *
 * The tree: holding ─┬─ alpha ── grandchild
 *                    └─ beta
 */
describe('the tenant tree (e2e)', () => {
  let node: TestApp;
  let holding: Other;
  let alpha: Other;
  let beta: Other;
  let grandchild: Other;

  beforeEach(async () => {
    node = await bootApp();
    holding = await node.otherTenant(`h-${randomUUID().slice(0, 6)}`);
    alpha = await node.otherTenant(`a-${randomUUID().slice(0, 6)}`);
    beta = await node.otherTenant(`b-${randomUUID().slice(0, 6)}`);
    grandchild = await node.otherTenant(`g-${randomUUID().slice(0, 6)}`);
  });
  afterEach(() => node.close());

  const place = (tenant: { id: string }, parentId: string | null) =>
    node.admin().patch(`/v1/tenants/${tenant.id}`).send({ parentId });

  async function buildTree() {
    await place(alpha, holding.id).expect(200);
    await place(beta, holding.id).expect(200);
    await place(grandchild, alpha.id).expect(200);
  }

  const closure = () =>
    node.db
      .select({
        ancestor: tenantClosure.ancestorId,
        descendant: tenantClosure.descendantId,
        depth: tenantClosure.depth,
      })
      .from(tenantClosure)
      .where(
        inArray(tenantClosure.ancestorId, [
          holding.id,
          alpha.id,
          beta.id,
          grandchild.id,
        ]),
      );

  /** A test item written in each tenant (by a client of its own). */
  async function itemsInEach() {
    const ids: Record<string, string> = {};
    for (const [name, tenant] of Object.entries({
      holding,
      alpha,
      beta,
      grandchild,
    })) {
      const client = await tenant.client();
      const res = await node.writeItem(client.auth, {
        title: name,
        body: name,
      });
      expect(res.status).toBe(201);
      ids[name] = res.body.id as string;
    }
    return ids;
  }

  it('places tenants with their closure, moves a subtree, and refuses a cycle', async () => {
    await buildTree();
    expect(
      (await node.admin().get(`/v1/tenants/${alpha.id}`).expect(200)).body
        .parentId,
    ).toBe(holding.id);
    expect(await closure()).toEqual(
      expect.arrayContaining([
        { ancestor: holding.id, descendant: alpha.id, depth: 1 },
        { ancestor: holding.id, descendant: beta.id, depth: 1 },
        { ancestor: holding.id, descendant: grandchild.id, depth: 2 },
        { ancestor: alpha.id, descendant: grandchild.id, depth: 1 },
      ]),
    );
    expect(await closure()).toHaveLength(4);

    // Under itself, or under one of its descendants: a cycle.
    for (const parent of [holding, alpha, grandchild]) {
      await place(holding, parent.id)
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe('tenant_tree_cycle'));
    }
    // The operator tenant is in no tree, on either side.
    await place(alpha, node.tenantId)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('operator_tenant'));
    await place({ id: node.tenantId }, holding.id)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('operator_tenant'));
    await place(alpha, randomUUID()).expect(404);
    expect(await closure()).toHaveLength(4);

    // alpha (with its grandchild) moves under beta: holding still above both.
    await place(alpha, beta.id).expect(200);
    expect(await closure()).toEqual(
      expect.arrayContaining([
        { ancestor: holding.id, descendant: beta.id, depth: 1 },
        { ancestor: holding.id, descendant: alpha.id, depth: 2 },
        { ancestor: holding.id, descendant: grandchild.id, depth: 3 },
        { ancestor: beta.id, descendant: alpha.id, depth: 1 },
        { ancestor: beta.id, descendant: grandchild.id, depth: 2 },
        { ancestor: alpha.id, descendant: grandchild.id, depth: 1 },
      ]),
    );
    expect(await closure()).toHaveLength(6);

    // A root again: only what is below it stays.
    await place(alpha, null).expect(200);
    expect(await closure()).toEqual(
      expect.arrayContaining([
        { ancestor: holding.id, descendant: beta.id, depth: 1 },
        { ancestor: alpha.id, descendant: grandchild.id, depth: 1 },
      ]),
    );
    expect(await closure()).toHaveLength(2);

    // Audited where tenants' changes are: the operators' log and its own.
    const entries = await node.auditEntries({
      action: 'tenant.updated',
      targetId: alpha.id,
    });
    expect(entries.map((entry) => entry.tenantId)).toEqual(
      expect.arrayContaining([node.tenantId, alpha.id]),
    );
    expect(entries[0]!.details).toMatchObject({
      parentId: { from: beta.id, to: null },
    });

    // A new tenant placed at creation.
    const slug = `n-${randomUUID().slice(0, 6)}`;
    const created = await node
      .admin()
      .post('/v1/tenants')
      .send({
        name: slug,
        slug,
        administratorEmail: `${slug}@example.com`,
        parentId: holding.id,
      })
      .expect(201);
    expect(created.body.parentId).toBe(holding.id);
    const rows = await node.db
      .select()
      .from(tenantClosure)
      .where(eq(tenantClosure.descendantId, created.body.id as string));
    expect(rows).toEqual([
      expect.objectContaining({ ancestorId: holding.id, depth: 1 }),
    ]);
  });

  it('keeps a tenant with children from deletion', async () => {
    await buildTree();
    await node
      .admin()
      .post(`/v1/tenants/${alpha.id}/deletion`)
      .send({ slug: alpha.slug })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('tenant_has_children'));
    // A leaf goes; and no child is placed under a tenant being deleted.
    await node
      .admin()
      .post(`/v1/tenants/${beta.id}/deletion`)
      .send({ slug: beta.slug })
      .expect(200);
    await place(grandchild, beta.id)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('tenant_deletion_pending'));
  });

  describe('as the app role, in SQL', () => {
    /** The test items the app role reads with these settings, by title. */
    async function readAs(tenantId: string, readTenants: string[]) {
      const app = new Client({ connectionString: node.database.url });
      await app.connect();
      try {
        await app.query('begin');
        await app.query(
          `select set_config('app.tenant_id', $1, true), set_config('app.read_tenants', $2, true)`,
          [tenantId, readTenants.join(',')],
        );
        const { rows } = await app.query<{ title: string }>(
          'select title from test_items order by title',
        );
        await app.query('rollback');
        return rows.map((row) => row.title);
      } finally {
        await app.end();
      }
    }

    it('reads one tenant without the opt-in, the subtree with it, never a parent or a sibling', async () => {
      await itemsInEach();
      await buildTree();

      // Without the opt-in (read_tenants is the tenant itself): its own rows.
      expect(await readAs(holding.id, [holding.id])).toEqual(['holding']);
      expect(await readAs(alpha.id, [alpha.id])).toEqual(['alpha']);

      // A consolidated read of the holding: itself and everything below.
      expect(
        await readAs(holding.id, [
          holding.id,
          alpha.id,
          beta.id,
          grandchild.id,
        ]),
      ).toEqual(['alpha', 'beta', 'grandchild', 'holding']);
      // Only what it asked for.
      expect(await readAs(holding.id, [holding.id, grandchild.id])).toEqual([
        'grandchild',
        'holding',
      ]);

      // A child naming its parent and its sibling (a bug, a forged setting):
      // the tree says no; its own subtree still reads.
      expect(
        await readAs(alpha.id, [alpha.id, holding.id, beta.id, grandchild.id]),
      ).toEqual(['alpha', 'grandchild']);
      expect(await readAs(alpha.id, [holding.id, beta.id])).toEqual([]);
      expect(await readAs(grandchild.id, [holding.id, alpha.id])).toEqual([]);
      // A tenant outside the tree reads nobody's but its own.
      expect(
        await readAs(node.tenantId, [node.tenantId, holding.id, alpha.id]),
      ).toEqual([]);

      // Moved out, the subtree is no longer the holding's.
      await place(alpha, null).expect(200);
      expect(
        await readAs(holding.id, [holding.id, alpha.id, grandchild.id]),
      ).toEqual(['holding']);
    });

    it('writes only to app.tenant_id, even while reading the subtree', async () => {
      const ids = await itemsInEach();
      await buildTree();
      const app = new Client({ connectionString: node.database.url });
      await app.connect();
      try {
        await app.query('begin');
        await app.query(
          `select set_config('app.tenant_id', $1, true), set_config('app.read_tenants', $2, true)`,
          [holding.id, [holding.id, alpha.id].join(',')],
        );
        const updated = await app.query(
          `update test_items set title = 'changed' where id = $1`,
          [ids.alpha],
        );
        expect(updated.rowCount).toBe(0);
        const deleted = await app.query(
          'delete from test_items where id = $1',
          [ids.alpha],
        );
        expect(deleted.rowCount).toBe(0);
        await expect(
          app.query(
            `insert into test_items (tenant_id, title, body, owner_id) values ($1, 'x', 'x', 'user:x')`,
            [alpha.id],
          ),
        ).rejects.toThrow(/row-level security/);
        await app.query('rollback');
      } finally {
        await app.end();
      }
    });

    it('runs a consolidated scope read-only', async () => {
      await itemsInEach();
      await buildTree();
      const db = node.app.get<Database>(getDrizzleToken());
      const scope = consolidatedScope(holding.id, [alpha.id]);
      const titles = await node.app
        .get(Tenancy)
        .run(scope, () =>
          db.select({ title: testItems.title }).from(testItems),
        );
      expect(titles.map((row) => row.title).sort()).toEqual([
        'alpha',
        'holding',
      ]);
      await expect(
        node.app.get(Tenancy).run(scope, () =>
          db
            .update(testItems)
            .set({ title: 'changed' })
            .where(
              or(
                eq(testItems.tenantId, holding.id),
                eq(testItems.tenantId, alpha.id),
              ),
            ),
        ),
        // 25006: read_only_sql_transaction.
      ).rejects.toMatchObject({ cause: { code: '25006' } });
    });
  });

  describe('the consolidated audit log', () => {
    const tenantsOf = (body: { items: { tenantId: string | null }[] }) =>
      new Set(body.items.map((entry) => entry.tenantId));

    it('reads the subtree with Access.readConsolidated, never a parent, a sibling, or without the opt-in', async () => {
      await buildTree();

      // Without the opt-in: the tenant's own log, as always.
      const own = await holding.admin
        .get('/v1/access/audit?limit=100')
        .expect(200);
      expect(tenantsOf(own.body)).toEqual(new Set([holding.id]));

      const below = await holding.admin
        .get('/v1/access/consolidated/tenants')
        .expect(200);
      expect(below.body.items).toEqual([
        expect.objectContaining({
          id: alpha.id,
          parentId: holding.id,
          depth: 1,
        }),
        expect.objectContaining({
          id: beta.id,
          parentId: holding.id,
          depth: 1,
        }),
        expect.objectContaining({
          id: grandchild.id,
          parentId: alpha.id,
          depth: 2,
        }),
      ]);

      const consolidated = await holding.admin
        .get('/v1/access/consolidated/audit?limit=100')
        .expect(200);
      expect(tenantsOf(consolidated.body)).toEqual(
        new Set([holding.id, alpha.id, beta.id, grandchild.id]),
      );

      // alpha: itself and its grandchild, never the holding nor beta.
      const fromAlpha = await alpha.admin
        .get('/v1/access/consolidated/audit?limit=100')
        .expect(200);
      expect(tenantsOf(fromAlpha.body)).toEqual(
        new Set([alpha.id, grandchild.id]),
      );
      // A leaf: its own log.
      const fromBeta = await beta.admin
        .get('/v1/access/consolidated/audit?limit=100')
        .expect(200);
      expect(tenantsOf(fromBeta.body)).toEqual(new Set([beta.id]));
      expect(
        (await beta.admin.get('/v1/access/consolidated/tenants').expect(200))
          .body.items,
      ).toEqual([]);

      // Audited in the reader's tenant and in each tenant read.
      const reads = await node.auditEntries({
        action: 'tenant.consolidated-read',
        targetId: holding.id,
      });
      expect(new Set(reads.map((entry) => entry.tenantId))).toEqual(
        new Set([holding.id, alpha.id, beta.id, grandchild.id]),
      );
      expect(reads[0]!.details).toMatchObject({ what: 'audit' });

      // A deactivated tenant exposes nothing, nor what is below it.
      await node
        .admin()
        .patch(`/v1/tenants/${alpha.id}`)
        .send({ active: false })
        .expect(200);
      const without = await holding.admin
        .get('/v1/access/consolidated/audit?limit=100')
        .expect(200);
      expect(tenantsOf(without.body)).toEqual(new Set([holding.id, beta.id]));
    });

    it('needs Access.readConsolidated', async () => {
      await buildTree();
      // An editor of the holding: neither the audit log nor the subtree.
      const editor = await holding.user(['editor']);
      await editor.agent.get('/v1/access/consolidated/audit').expect(403);
      await editor.agent.get('/v1/access/consolidated/tenants').expect(403);
      // An API client of the holding, whatever it may do: users only.
      const client = await holding.client();
      await node
        .http()
        .get('/v1/access/consolidated/audit')
        .set('Authorization', client.auth)
        .expect(({ status }) => expect([401, 403]).toContain(status));
    });
  });
});
