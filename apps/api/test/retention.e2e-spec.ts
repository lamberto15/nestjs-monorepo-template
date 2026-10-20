import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { SoftDeletePurgeJob } from '../src/iam/resources/soft-delete-purge.job.js';
import { AccountDeletionJob } from '../src/platform/account/account-deletion.job.js';
import { RetentionRegistry } from '../src/platform/retention/retention.registry.js';
import { RetentionScheduler } from '../src/platform/retention/retention.scheduler.js';
import {
  RETENTION,
  type RetentionJob,
} from '../src/platform/retention/retention.service.js';
import { testItems } from './fixtures/test-items/test-items.tables.js';
import { bootApp, type TestApp } from './support.js';

const DAY = 86_400_000;

/**
 * Retention rules and legal holds (roadmap item 5, docs/retention.md): a
 * declared rule purges or anonymises records past the tenant's days on a
 * queue, never in a request; a legal hold keeps a record from a delete, the
 * recycle bin's purge, the retention job and an account deletion; both are
 * audited and per tenant.
 */
describe('retention and legal holds (e2e)', () => {
  let node: TestApp;
  let queue: Queue<RetentionJob>;

  beforeEach(async () => {
    node = await bootApp();
    queue = node.app.get<Queue<RetentionJob>>(getQueueToken(RETENTION));
    const registry = node.app.get(RetentionRegistry);
    registry.register({
      name: 'test-item',
      label: 'Test items',
      subject: 'TestItem',
      table: testItems,
      ageColumn: testItems.createdAt,
      action: 'purge',
      defaultDays: 30,
      minDays: 7,
    });
    registry.register({
      name: 'test-item-body',
      label: 'Test item bodies',
      subject: 'TestItem',
      table: testItems,
      ageColumn: testItems.createdAt,
      action: 'anonymise',
      defaultDays: 30,
      anonymise: { set: { body: null }, pending: isNotNull(testItems.body) },
    });
  });
  afterEach(() => node.close());

  /** An API client's test item, `ageDays` old. */
  async function item(auth: string, ageDays = 0) {
    const id = (
      await node.writeItem(auth, { title: 'Item', body: 'secret' }).expect(201)
    ).body.id as string;
    if (ageDays > 0) {
      await node.db
        .update(testItems)
        .set({ createdAt: new Date(Date.now() - ageDays * DAY) })
        .where(eq(testItems.id, id));
    }
    return id;
  }

  const rows = (ids: string[]) =>
    node.db
      .select({ id: testItems.id, body: testItems.body })
      .from(testItems)
      .where(inArray(testItems.id, ids));

  /** The scheduler's run and the workers' batches it queues, to the end. */
  async function runRetention() {
    const queued = await node.app.get(RetentionScheduler).run();
    await vi.waitFor(
      async () => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        expect(counts).toEqual({ waiting: 0, active: 0, delayed: 0 });
      },
      { timeout: 20_000, interval: 50 },
    );
    return queued;
  }

  const hold = (body: object) =>
    node.admin().post('/v1/legal-holds').send(body);

  describe('legal holds', () => {
    it('lets only hold managers place, list and release them', async () => {
      const editor = await node.user(['editor']);
      const body = { subject: 'TestItem', reason: 'Case 1' };
      await editor.agent.post('/v1/legal-holds').send(body).expect(403);
      await editor.agent.get('/v1/legal-holds').expect(403);

      const placed = await hold({ ...body, recordId: randomUUID() }).expect(
        201,
      );
      expect(placed.body).toMatchObject({
        subject: 'TestItem',
        active: true,
        reason: 'Case 1',
        releasedAt: null,
      });
      await editor.agent
        .post(`/v1/legal-holds/${placed.body.id}/release`)
        .send({})
        .expect(403);

      const bad = await hold({ subject: 'testitem', reason: 'x' }).expect(400);
      expect(bad.body.code).toBe('validation_failed');
      await hold({ subject: 'TestItem', reason: '' }).expect(400);

      const released = await node
        .admin()
        .post(`/v1/legal-holds/${placed.body.id}/release`)
        .send({ note: 'Settled' })
        .expect(200);
      expect(released.body).toMatchObject({
        active: false,
        releaseNote: 'Settled',
      });
      await node
        .admin()
        .post(`/v1/legal-holds/${placed.body.id}/release`)
        .send({})
        .expect(409);
      await node
        .admin()
        .post(`/v1/legal-holds/${randomUUID()}/release`)
        .send({})
        .expect(404);

      const active = await node
        .admin()
        .get('/v1/legal-holds?active=true')
        .expect(200);
      expect(active.body.items).toEqual([]);
      const all = await node.admin().get('/v1/legal-holds').expect(200);
      expect(all.body.items.map((h: { id: string }) => h.id)).toEqual([
        placed.body.id,
      ]);

      expect(
        await node.auditEntries({
          action: 'legal-hold.placed',
          targetId: placed.body.id,
        }),
      ).toHaveLength(1);
      expect(
        await node.auditEntries({
          action: 'legal-hold.released',
          targetId: placed.body.id,
        }),
      ).toHaveLength(1);
    });

    it('refuses to delete a held record (one, or all of its subject) until the hold is released', async () => {
      const { auth } = await node.client();
      const held = await item(auth);
      const other = await item(auth);
      const placed = await hold({
        subject: 'TestItem',
        recordId: held,
        reason: 'Case 2',
      }).expect(201);

      const refused = await node
        .http()
        .delete(`/v1/test-items/${held}`)
        .set('Authorization', auth)
        .expect(409);
      expect(refused.body.code).toBe('legal_hold');
      await node
        .http()
        .delete(`/v1/test-items/${other}`)
        .set('Authorization', auth)
        .expect(204);

      // A hold on the whole subject covers records made after it.
      const wide = await hold({ subject: 'TestItem', reason: 'Audit' }).expect(
        201,
      );
      const later = await item(auth);
      await node
        .http()
        .delete(`/v1/test-items/${later}`)
        .set('Authorization', auth)
        .expect(409);

      for (const id of [placed.body.id, wide.body.id]) {
        await node
          .admin()
          .post(`/v1/legal-holds/${id}/release`)
          .send({})
          .expect(200);
      }
      await node
        .http()
        .delete(`/v1/test-items/${held}`)
        .set('Authorization', auth)
        .expect(204);
    });

    it('keeps a held record in the recycle bin when the purge runs', async () => {
      const { auth } = await node.client();
      const held = await item(auth);
      const free = await item(auth);
      for (const id of [held, free]) {
        await node
          .http()
          .delete(`/v1/test-items/${id}`)
          .set('Authorization', auth)
          .expect(204);
      }
      // Held after it was deleted, as a case opened later would.
      await hold({
        subject: 'TestItem',
        recordId: held,
        reason: 'Late',
      }).expect(201);
      await node.db
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 40 * DAY) })
        .where(inArray(testItems.id, [held, free]));

      expect(await node.app.get(SoftDeletePurgeJob).run()).toMatchObject({
        TestItem: 1,
      });
      expect((await rows([held, free])).map((row) => row.id)).toEqual([held]);
    });

    it('keeps an account whose person is held from being deleted, and carries on once released', async () => {
      const email = `${randomUUID().slice(0, 8)}@example.com`;
      const token = await node.invite(node.admin(), {
        email,
        name: 'Ada',
        roleIds: await node.roleIds('editor'),
      });
      const password = await node.acceptAsNew(token, 'Ada');
      const ada = await node.signIn(email, password);
      const id = (await ada.get('/v1/auth/me').expect(200)).body.user
        .id as string;
      await ada.post('/v1/account/deletion').send({ password }).expect(200);

      const placed = await hold({
        subject: 'User',
        recordId: id,
        reason: 'Investigation',
      }).expect(201);
      const later = new Date(Date.now() + 15 * DAY);
      expect(await node.app.get(AccountDeletionJob).run(later)).toBe(0);
      await ada.get('/v1/auth/me').expect(200); // still whole, still signed in

      await node
        .admin()
        .post(`/v1/legal-holds/${placed.body.id}/release`)
        .send({})
        .expect(200);
      expect(await node.app.get(AccountDeletionJob).run(later)).toBe(1);
      await ada.get('/v1/auth/me').expect(401);
    });
  });

  describe('retention rules', () => {
    it('lists the declared rules, off until the tenant turns one on, with its minimum', async () => {
      const editor = await node.user(['editor']);
      await editor.agent.get('/v1/retention/rules').expect(403);
      await editor.agent
        .put('/v1/retention/rules/test-item')
        .send({ enabled: true })
        .expect(403);

      const listed = await node.admin().get('/v1/retention/rules').expect(200);
      expect(
        listed.body.items.find((r: { name: string }) => r.name === 'test-item'),
      ).toMatchObject({
        subject: 'TestItem',
        action: 'purge',
        enabled: false,
        days: 30,
        defaultDays: 30,
        minDays: 7,
        lastRunAt: null,
      });

      const tooShort = await node
        .admin()
        .put('/v1/retention/rules/test-item')
        .send({ enabled: true, days: 3 })
        .expect(400);
      expect(tooShort.body.code).toBe('validation_failed');
      await node
        .admin()
        .put('/v1/retention/rules/nope')
        .send({ enabled: true })
        .expect(404);

      const set = await node
        .admin()
        .put('/v1/retention/rules/test-item')
        .send({ enabled: true, days: 60 })
        .expect(200);
      expect(set.body).toMatchObject({ enabled: true, days: 60 });
      // Only the switch: the days stay.
      const off = await node
        .admin()
        .put('/v1/retention/rules/test-item')
        .send({ enabled: false })
        .expect(200);
      expect(off.body).toMatchObject({ enabled: false, days: 60 });
      expect(
        await node.auditEntries({
          action: 'retention.policy-changed',
          targetId: 'test-item',
        }),
      ).toHaveLength(2);
    });

    it('purges the old records of an enabled rule on the queue, sparing the young and the held', async () => {
      const { auth } = await node.client();
      const old = await item(auth, 40);
      const heldOld = await item(auth, 40);
      const young = await item(auth, 5);
      const holdRow = await hold({
        subject: 'TestItem',
        recordId: heldOld,
        reason: 'Case 3',
      }).expect(201);

      // Declared, not turned on: nothing is queued, nothing goes.
      expect(await runRetention()).toBe(0);
      expect(await rows([old, heldOld, young])).toHaveLength(3);

      await node
        .admin()
        .put('/v1/retention/rules/test-item')
        .send({ enabled: true })
        .expect(200);
      expect(await runRetention()).toBe(1);
      expect(
        (await rows([old, heldOld, young])).map((r) => r.id).sort(),
      ).toEqual([heldOld, young].sort());

      const purged = await node.auditEntries({ action: 'retention.purged' });
      expect(purged).toHaveLength(1);
      expect(purged[0]).toMatchObject({
        actor: 'system:retention',
        details: { rule: 'test-item', ids: [old], retentionDays: 30 },
      });
      const status = await node.admin().get('/v1/retention/rules').expect(200);
      expect(
        status.body.items.find((r: { name: string }) => r.name === 'test-item'),
      ).toMatchObject({ lastCount: 1, lastRunAt: expect.any(String) });

      // The hold ends; the next night it goes too.
      await node
        .admin()
        .post(`/v1/legal-holds/${holdRow.body.id}/release`)
        .send({})
        .expect(200);
      await runRetention();
      expect((await rows([heldOld, young])).map((r) => r.id)).toEqual([young]);
    });

    it('anonymises instead: the rows stay, what identifies is overwritten, once', async () => {
      const { auth } = await node.client();
      const old = await item(auth, 40);
      const young = await item(auth, 5);
      await node
        .admin()
        .put('/v1/retention/rules/test-item-body')
        .send({ enabled: true })
        .expect(200);
      await runRetention();
      const after = await rows([old, young]);
      expect(after.find((r) => r.id === old)?.body).toBeNull();
      expect(after.find((r) => r.id === young)?.body).toBe('secret');
      expect(
        await node.auditEntries({ action: 'retention.anonymised' }),
      ).toHaveLength(1);
      // Anonymised rows are no longer pending: the next night writes nothing.
      await runRetention();
      expect(
        await node.auditEntries({ action: 'retention.anonymised' }),
      ).toHaveLength(1);
    });

    it('works in batches and in the tenant that turned the rule on only', async () => {
      const other = await node.otherTenant();
      await other.admin
        .put('/v1/retention/rules/test-item')
        .send({ enabled: false })
        .expect(200);
      const { auth } = await node.client();
      const old = await item(auth, 40);
      await node
        .admin()
        .put('/v1/retention/rules/test-item')
        .send({ enabled: true })
        .expect(200);
      expect(await runRetention()).toBe(1); // this tenant's rule alone
      expect(await rows([old])).toHaveLength(0);
    });
  });
});
