import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  DataTransferProcessor,
  STALLED_REASON,
} from '../src/platform/data-transfer/data-transfer.processor.js';
import { DATA_TRANSFERS } from '../src/platform/data-transfer/data-transfer.service.js';
import { DataTransferRegistry } from '../src/platform/data-transfer/data-transfer.registry.js';
import type { TransferFinished } from '../src/platform/data-transfer/data-transfer.types.js';
import { ReportRunnerJob } from '../src/platform/reports/report-runner.job.js';
import { ReportsService } from '../src/platform/reports/reports.service.js';
import { reportSchedules } from '../src/platform/reports/reports.tables.js';
import { bootApp, type TestApp } from './support.js';

/** The path and query of a signed URL: the tests reach the app on its own port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/**
 * A link of a mail's HTML, its entities decoded. `&amp;` last: decoded
 * first, it would turn `&amp;#x2F;` (a literal `&#x2F;` in the link) into a
 * `/` on the next replace (CodeQL js/double-escaping).
 */
const linkOf = (html: string) =>
  /href="([^"]+)"/
    .exec(html)![1]!
    .replace(/&#x3D;/g, '=')
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&');

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

describe('scheduled reports (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const daily = {
    name: 'Daily items',
    exporter: 'test-items',
    format: 'csv',
    timezone: 'Asia/Manila',
    schedule: { every: 'daily', hour: 8 },
  };

  /** An editor, with their address. */
  async function editor() {
    const person = await node.user(['editor']);
    const me = await person.agent.get('/v1/auth/me').expect(200);
    return { ...person, email: me.body.user.email as string };
  }

  /** Waits until the transfer finished, as its owner sees it. */
  async function finished(
    get: (path: string) => Promise<{ body: { status: string } }>,
    id: string,
  ) {
    let status = '';
    for (let tries = 0; tries < 200; tries++) {
      status = (await get(`/v1/data/transfers/${id}`)).body.status;
      if (['completed', 'failed'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return status;
  }

  /** The first mail matching, waiting longer than waitForMail (an export runs first). */
  async function mailTo(to: string, subject: RegExp) {
    for (let tries = 0; tries < 200; tries++) {
      const found = node.mailbox.find({ to, subject });
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return node.waitForMail({ to, subject });
  }

  const audit = async (action: string, targetId: string) =>
    (
      await node
        .admin()
        .get(`/v1/access/audit?action=${action}&targetId=${targetId}`)
        .expect(200)
    ).body.items as { details: Record<string, unknown> }[];

  it('schedules a report in its time zone; only its owner sees or changes it', async () => {
    const ada = await editor();
    const bob = await editor();
    const before = Date.now();
    const created = await ada.agent.post('/v1/reports').send(daily).expect(201);
    expect(created.body).toMatchObject({
      name: 'Daily items',
      exporter: 'test-items',
      format: 'csv',
      filters: {},
      timezone: 'Asia/Manila',
      schedule: { every: 'daily', hour: 8 },
      recipients: [ada.email],
      active: true,
      lastRunAt: null,
      lastStatus: null,
    });
    // The next 08:00 in Manila (+08:00): 00:00Z, within a day.
    const next = new Date(created.body.nextRunAt);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(before);
    expect(next.getTime() - before).toBeLessThanOrEqual(86_400_000);
    const id = created.body.id as string;

    await bob.agent
      .post('/v1/reports')
      .send({ ...daily, name: 'Bob' })
      .expect(201);
    const mine = await ada.agent.get('/v1/reports').expect(200);
    expect(mine.body.items.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await ada.agent.get(`/v1/reports/${id}`).expect(200)).body.id).toBe(
      id,
    );

    await bob.agent.get(`/v1/reports/${id}`).expect(404);
    await bob.agent
      .patch(`/v1/reports/${id}`)
      .send({ name: 'Mine' })
      .expect(404);
    await bob.agent.delete(`/v1/reports/${id}`).expect(404);
    await bob.agent.post(`/v1/reports/${id}/run`).expect(404);

    // A change of schedule computes the next run again: Monday 09:00 Manila.
    const updated = await ada.agent
      .patch(`/v1/reports/${id}`)
      .send({
        schedule: { every: 'weekly', weekday: 1, hour: 9 },
        name: 'Weekly',
      })
      .expect(200);
    const monday = new Date(updated.body.nextRunAt);
    expect(monday.getUTCHours()).toBe(1);
    // 09:00 in Manila is a Monday there (01:00Z the same day).
    expect(monday.getUTCDay()).toBe(1);
    expect(updated.body.name).toBe('Weekly');
    // A change of name alone leaves the next run as it was.
    const renamed = await ada.agent
      .patch(`/v1/reports/${id}`)
      .send({ name: 'Weekly items' })
      .expect(200);
    expect(renamed.body.nextRunAt).toBe(updated.body.nextRunAt);

    expect(await audit('report.created', id)).toHaveLength(1);
    expect((await audit('report.updated', id))[1]!.details).toMatchObject({
      changes: { name: { from: 'Daily items', to: 'Weekly' } },
    });
    await ada.agent.delete(`/v1/reports/${id}`).expect(204);
    await ada.agent.get(`/v1/reports/${id}`).expect(404);
    expect(await audit('report.deleted', id)).toHaveLength(1);
  });

  it('refuses an export the owner may not run, bad filters, zones, schedules and recipients', async () => {
    const ada = await editor();
    const refused = async (body: Record<string, unknown>) =>
      paths(
        (
          await ada.agent
            .post('/v1/reports')
            .send({ ...daily, ...body })
            .expect(400)
        ).body,
      );
    expect(await refused({ exporter: 'nothing' })).toEqual(['exporter']);
    expect(await refused({ filters: { 'createdAt.gte': 'bogus' } })).toEqual([
      'filters.createdAt.gte',
    ]);
    expect(await refused({ timezone: 'Mars/Olympus' })).toEqual(['timezone']);
    expect(
      (await refused({ schedule: { every: 'monthly', day: 31, hour: 8 } }))[0],
    ).toMatch(/^schedule/);
    expect(
      (await refused({ schedule: { every: 'hourly', hour: 8 } }))[0],
    ).toMatch(/^schedule/);
    expect(
      (await refused({ schedule: { every: 'daily', hour: 24 } }))[0],
    ).toMatch(/^schedule/);
    expect(
      await refused({
        recipients: Array.from({ length: 21 }, (_, i) => `r${i}@example.com`),
      }),
    ).toEqual(['recipients']);
    expect((await refused({ recipients: ['not-an-address'] }))[0]).toMatch(
      /^recipients/,
    );

    // Someone without TestItem.read may not schedule the test items.
    const nobody = await node.user([]);
    const forbidden = await nobody.agent
      .post('/v1/reports')
      .send(daily)
      .expect(400);
    expect(paths(forbidden.body)).toEqual(['exporter']);

    // A PATCH is checked the same way.
    const created = await ada.agent.post('/v1/reports').send(daily).expect(201);
    const patched = await ada.agent
      .patch(`/v1/reports/${created.body.id}`)
      .send({ filters: { 'createdAt.gte': 'bogus' } })
      .expect(400);
    expect(paths(patched.body)).toEqual(['filters.createdAt.gte']);

    // At most 20 active reports per owner (Ada has one).
    for (let i = 0; i < 19; i++) {
      await ada.agent
        .post('/v1/reports')
        .send({ ...daily, name: `Report ${i}` })
        .expect(201);
    }
    expect(await refused({})).toEqual(['active']);
    const paused = await ada.agent
      .post('/v1/reports')
      .send({ ...daily, name: 'Paused', active: false })
      .expect(201);
    const reactivated = await ada.agent
      .patch(`/v1/reports/${paused.body.id}`)
      .send({ active: true })
      .expect(400);
    expect(paths(reactivated.body)).toEqual(['active']);
  });

  it('runs a report now: the recipients get a link that downloads the file', async () => {
    const ada = await editor();
    await node
      .writeItem(ada.agent, { title: 'In the report', body: 'x' })
      .expect(201);
    const created = await ada.agent
      .post('/v1/reports')
      .send({ ...daily, recipients: [ada.email, 'boss@example.com'] })
      .expect(201);
    const id = created.body.id as string;
    const ran = await ada.agent.post(`/v1/reports/${id}/run`).expect(202);
    expect(ran.body).toEqual({ id: expect.any(String), status: 'queued' });
    expect(
      await finished((path) => ada.agent.get(path).expect(200), ran.body.id),
    ).toBe('completed');

    const mail = await mailTo('boss@example.com', /Daily items/);
    expect(mail.subject).toBe('Report ready: Daily items');
    // The owner is the To; the others are in Bcc, unseen by each other.
    expect(mail.to.map((to) => to.address)).toEqual([ada.email]);
    expect(mail.bcc.map((to) => to.address)).toEqual(['boss@example.com']);
    const file = await node
      .http()
      .get(local(linkOf(mail.html!)))
      .expect(200);
    expect(String(file.text ?? file.body)).toContain('In the report');

    const report = (await ada.agent.get(`/v1/reports/${id}`).expect(200)).body;
    expect(report).toMatchObject({
      lastStatus: 'completed',
      lastTransferId: ran.body.id,
    });
    expect(report.lastRunAt).not.toBeNull();
    // Run now leaves the schedule as it was.
    expect(report.nextRunAt).toBe(created.body.nextRunAt);
    expect((await audit('report.ran', id))[0]!.details).toEqual({
      transferId: ran.body.id,
      trigger: 'manual',
    });
    expect((await audit('report.finished', id))[0]!.details).toEqual({
      reportId: id,
      transferId: ran.body.id,
      status: 'completed',
    });
    expect(
      (await audit('data.export-started', ran.body.id))[0]!.details,
    ).toMatchObject({ name: 'test-items', report: id, trigger: 'manual' });
    // Once per transfer.
    expect(node.mailbox.filter({ subject: /Daily items/ })).toHaveLength(1);
  });

  it('mails the failure when the export fails, and keeps the status', async () => {
    // An export that fails on the worker, every time.
    node.app.get(DataTransferRegistry).registerExporter({
      name: 'broken',
      subject: 'TestItem',
      allowed: () => true,
      columns: [{ key: 'id' }],
      // oxlint-disable-next-line require-yield
      async *batches() {
        throw new Error('The source is gone.');
      },
    });
    const ada = await editor();
    const created = await ada.agent
      .post('/v1/reports')
      .send({ ...daily, name: 'Broken one', exporter: 'broken' })
      .expect(201);
    const ran = await ada.agent
      .post(`/v1/reports/${created.body.id}/run`)
      .expect(202);
    expect(
      await finished((path) => ada.agent.get(path).expect(200), ran.body.id),
    ).toBe('failed');
    const mail = await mailTo(ada.email, /Broken one/);
    expect(mail.subject).toBe('Report failed: Broken one');
    expect(mail.html).not.toContain('The source is gone');
    expect(
      (await ada.agent.get(`/v1/reports/${created.body.id}`).expect(200)).body,
    ).toMatchObject({ lastStatus: 'failed', lastTransferId: ran.body.id });
    expect(
      (await audit('report.finished', created.body.id))[0]!.details,
    ).toMatchObject({ status: 'failed' });
  });

  it('tells the listeners when BullMQ itself fails a stalled export (the processor never sees it)', async () => {
    const heard: TransferFinished[] = [];
    node.app.get(DataTransferRegistry).onFinished((event) => {
      heard.push(event);
    });
    const ada = await editor();
    const started = await ada.agent
      .post('/v1/data/exports')
      .send({ name: 'test-items', format: 'csv' })
      .expect(202);
    const id = started.body.id as string;
    await finished((path) => ada.agent.get(path).expect(200), id);
    // The worker's `failed` event, as BullMQ emits it for a deferred stalled failure.
    const processor = node.app.get(DataTransferProcessor);
    const job = await node.app
      .get<Queue>(getQueueToken(DATA_TRANSFERS))
      .getJob(id);
    const failures = () =>
      heard.filter((event) => event.id === id && event.status === 'failed');
    // Any other reason is the processor's own failure, told already.
    await processor.onFailed(job, new Error('The source is gone.'));
    expect(failures()).toHaveLength(0);
    await processor.onFailed(job, new Error(STALLED_REASON));
    expect(failures()).toEqual([
      expect.objectContaining({
        error: STALLED_REASON,
        job: expect.objectContaining({ kind: 'export' }),
      }),
    ]);
    // A job gone meanwhile: nobody to tell, no error.
    await processor.onFailed(undefined, new Error(STALLED_REASON));
    expect(failures()).toHaveLength(1);
  });

  it("starts the due reports once, as their owners, and stops a deactivated owner's", async () => {
    const ada = await editor();
    const bob = await editor();
    const due = (await ada.agent.post('/v1/reports').send(daily).expect(201))
      .body;
    const paused = (
      await ada.agent
        .post('/v1/reports')
        .send({ ...daily, name: 'Paused', active: false })
        .expect(201)
    ).body;
    const bobs = (
      await bob.agent
        .post('/v1/reports')
        .send({ ...daily, name: "Bob's" })
        .expect(201)
    ).body;
    await node
      .admin()
      .patch(`/v1/access/users/${bob.id}`)
      .send({ active: false })
      .expect(204);

    const runner = node.app.get(ReportRunnerJob);
    const db = node.db;
    const [stale] = await db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, due.id));
    // Before the next run: nothing.
    expect(
      await runner.run(new Date(new Date(due.nextRunAt).getTime() - 60_000)),
    ).toBe(0);
    const now = new Date(new Date(due.nextRunAt).getTime() + 5 * 60_000);
    expect(await runner.run(now)).toBe(1);
    expect(await runner.run(now)).toBe(0);
    // A second runner holding the row as it was read claims nothing.
    const reports = node.app.get(ReportsService);
    expect(
      await node.inTenant(async () =>
        reports.start((await reports.owner(stale!))!, stale!, {
          trigger: 'schedule',
          now,
        }),
      ),
    ).toBeNull();

    const after = (await ada.agent.get(`/v1/reports/${due.id}`).expect(200))
      .body;
    expect(after.lastRunAt).toBe(now.toISOString());
    // The next 08:00 Manila after `now`: a day later.
    expect(new Date(after.nextRunAt).getTime()).toBe(
      new Date(due.nextRunAt).getTime() + 86_400_000,
    );
    expect((await audit('report.ran', due.id))[0]!.details).toMatchObject({
      trigger: 'schedule',
    });
    expect(
      (await audit('data.export-started', after.lastTransferId))[0]!.details,
    ).toMatchObject({ report: due.id, trigger: 'schedule' });
    expect(
      await finished(
        (path) => ada.agent.get(path).expect(200),
        after.lastTransferId,
      ),
    ).toBe('completed');
    await mailTo(ada.email, /Daily items/);

    const untouched = (
      await ada.agent.get(`/v1/reports/${paused.id}`).expect(200)
    ).body;
    expect(untouched.lastRunAt).toBeNull();

    // Bob's: made inactive, audited, not run.
    const bobsAudit = await audit('report.deactivated', bobs.id);
    expect(bobsAudit).toHaveLength(1);
    expect(bobsAudit[0]!.details).toMatchObject({ reason: 'owner_inactive' });
    await node
      .admin()
      .patch(`/v1/access/users/${bob.id}`)
      .send({ active: true })
      .expect(204);
    // Bob is back, his report stays stopped: a day later, only Ada's runs.
    expect(await runner.run(new Date(now.getTime() + 2 * 86_400_000))).toBe(1);
  });

  it('stops a report whose owner may no longer export its data', async () => {
    const ada = await editor();
    const report = (await ada.agent.post('/v1/reports').send(daily).expect(201))
      .body;
    await node
      .admin()
      .patch(`/v1/access/users/${ada.id}`)
      .send({ roleIds: [] })
      .expect(204);
    const runner = node.app.get(ReportRunnerJob);
    expect(
      await runner.run(new Date(new Date(report.nextRunAt).getTime() + 1000)),
    ).toBe(0);
    expect(
      (await audit('report.deactivated', report.id))[0]!.details,
    ).toMatchObject({ reason: 'export_not_allowed', owner: `user:${ada.id}` });
    expect(
      (await ada.agent.get(`/v1/reports/${report.id}`).expect(200)).body.active,
    ).toBe(false);
  });

  it("mails an API client's recipients, in the default language", async () => {
    const client = await node.client();
    const without = await node
      .http()
      .post('/v1/reports')
      .set('Authorization', client.auth)
      .send(daily)
      .expect(400);
    expect(paths(without.body)).toEqual(['recipients']);
    const created = await node
      .http()
      .post('/v1/reports')
      .set('Authorization', client.auth)
      .send({ ...daily, name: 'Client feed', recipients: ['ops@example.com'] })
      .expect(201);
    const ran = await node
      .http()
      .post(`/v1/reports/${created.body.id}/run`)
      .set('Authorization', client.auth)
      .expect(202);
    expect(
      await finished(
        (path) =>
          node.http().get(path).set('Authorization', client.auth).expect(200),
        ran.body.id,
      ),
    ).toBe('completed');
    const mail = await mailTo('ops@example.com', /Client feed/);
    expect(mail.subject).toBe('Report ready: Client feed');
    await node
      .http()
      .get(local(linkOf(mail.html!)))
      .expect(200);

    // Revoked: its reports stop.
    await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ active: false })
      .expect(200);
    const runner = node.app.get(ReportRunnerJob);
    expect(
      await runner.run(
        new Date(new Date(created.body.nextRunAt).getTime() + 1000),
      ),
    ).toBe(0);
    expect(
      (await audit('report.deactivated', created.body.id))[0]!.details,
    ).toMatchObject({ reason: 'owner_inactive', owner: `client:${client.id}` });
  });
});

describe('queue workers on shutdown (e2e)', () => {
  it('finish their running jobs before the HTTP server and socket.io close', async () => {
    const own = await bootApp();
    const worker = own.app.get(DataTransferProcessor).worker;
    const server = own.app.getHttpServer() as { listening: boolean };
    // Nest's dispose() closes socket.io (its Redis adapter too), then the HTTP
    // server: a job finishing after that emits on a closed connection.
    let listening: boolean | undefined;
    const close = worker.close.bind(worker);
    worker.close = (force?: boolean) => {
      listening ??= server.listening;
      return close(force);
    };
    await own.close();
    expect(listening).toBe(true);
  });
});
