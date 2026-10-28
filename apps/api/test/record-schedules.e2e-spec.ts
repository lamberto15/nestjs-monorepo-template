import { eq } from 'drizzle-orm';
import { DataTransferRegistry } from '../src/platform/data-transfer/data-transfer.registry.js';
import { RecordScheduleRunnerJob } from '../src/platform/recurrence/record-schedule-runner.job.js';
import {
  recordScheduleRuns,
  recordSchedules,
} from '../src/platform/recurrence/record-schedules.tables.js';
import { bootApp, type TestApp } from './support.js';

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

const HOUR = 3_600_000;

describe('recurring record schedules (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await node.close();
  });

  const daily = {
    name: 'Daily note',
    importer: 'notes',
    template: { title: 'Stand-up' },
    rrule: 'FREQ=DAILY',
    startDate: '2020-01-01',
    time: '08:00',
    timezone: 'Asia/Manila',
  };

  const audit = async (action: string, targetId: string) =>
    (
      await node
        .admin()
        .get(`/v1/access/audit?action=${action}&targetId=${targetId}`)
        .expect(200)
    ).body.items as { details: Record<string, unknown> }[];

  // A title is matched by `contains` only: the exact ones are kept here.
  const notesNamed = async (title: string) =>
    (
      (
        await node
          .admin()
          .get(
            `/v1/notes?title.contains=${encodeURIComponent(title)}&limit=100`,
          )
          .expect(200)
      ).body.items as { id: string; title: string }[]
    ).filter((note) => note.title === title);

  /** Makes the schedule's next occurrence due `ago` ms before the returned `now`. */
  async function due(id: string, ago = 0) {
    const [row] = await node.db
      .select()
      .from(recordSchedules)
      .where(eq(recordSchedules.id, id));
    const now = new Date(row!.nextRunAt!.getTime() + ago);
    return { now, nextRunAt: row!.nextRunAt! };
  }

  const state = async (id: string) =>
    (
      await node.db
        .select()
        .from(recordSchedules)
        .where(eq(recordSchedules.id, id))
    )[0]!;

  it('schedules in a time zone with a next-run preview; only the owner sees it', async () => {
    const ada = await node.user(['editor']);
    const bob = await node.user(['editor']);
    const created = await ada.agent
      .post('/v1/record-schedules')
      .send(daily)
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'active',
      occurrences: 0,
      maxOccurrences: null,
      failures: 0,
      lastStatus: null,
    });
    // 08:00 in Manila (+08:00) is 00:00Z.
    expect(new Date(created.body.nextRunAt).getUTCHours()).toBe(0);
    expect(new Date(created.body.nextRunAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const id = created.body.id as string;

    const preview = await ada.agent
      .post('/v1/record-schedules/preview')
      .send({
        rrule: 'FREQ=DAILY;COUNT=2',
        startDate: '2020-01-01',
        time: '08:00',
        timezone: 'Asia/Manila',
        count: 5,
      })
      .expect(200);
    expect(preview.body.occurrences).toHaveLength(2);
    expect(preview.body.occurrences[0]).toBe(created.body.nextRunAt);

    await bob.agent.get(`/v1/record-schedules/${id}`).expect(404);
    await bob.agent.post(`/v1/record-schedules/${id}/pause`).expect(404);
    await bob.agent.delete(`/v1/record-schedules/${id}`).expect(404);
    expect(
      (await ada.agent.get('/v1/record-schedules').expect(200)).body.items,
    ).toHaveLength(1);
    expect(await audit('recordSchedule.created', id)).toHaveLength(1);
  });

  it('refuses an importer or template the owner may not use, and a rule with no occurrence', async () => {
    const ada = await node.user(['editor']);
    const bad = await ada.agent
      .post('/v1/record-schedules')
      .send({
        ...daily,
        importer: 'nothing',
        template: { title: '' },
      })
      .expect(400);
    expect(paths(bad.body)).toContain('importer');
    // A rule the body's schema refuses: before anything else is checked.
    const hourly = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, rrule: 'FREQ=HOURLY' })
      .expect(400);
    expect(paths(hourly.body)).toEqual(['rrule']);
    const template = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, template: { title: '' } })
      .expect(400);
    expect(paths(template.body)).toContain('template.title');
    const past = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, rrule: 'FREQ=DAILY;UNTIL=20200102' })
      .expect(400);
    expect(paths(past.body)).toEqual(['rrule']);
    const viewer = await node.user(['viewer']);
    await viewer.agent.post('/v1/record-schedules').send(daily).expect(400);
  });

  it('creates the record once, however often or at once it is run', async () => {
    const ada = await node.user(['editor']);
    const { body } = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, template: { title: 'Once' } })
      .expect(201);
    const id = body.id as string;
    const runner = node.app.get(RecordScheduleRunnerJob);
    const { now, nextRunAt } = await due(id, HOUR);

    expect(await runner.run(new Date(nextRunAt.getTime() - 1000))).toBe(0);
    expect(await runner.run(now)).toBe(1);
    expect(await runner.run(now)).toBe(0);
    expect(await notesNamed('Once')).toHaveLength(1);
    const after = await state(id);
    expect(after).toMatchObject({ occurrences: 1, lastStatus: 'created' });
    expect(after.nextRunAt!.getTime() - nextRunAt.getTime()).toBe(24 * HOUR);

    // The same occurrence due again (a reset schedule, a replayed run): no second record.
    await node.db
      .update(recordSchedules)
      .set({ nextRunAt })
      .where(eq(recordSchedules.id, id));
    await runner.run(now);
    expect(await notesNamed('Once')).toHaveLength(1);
    expect((await state(id)).nextRunAt!.getTime() - nextRunAt.getTime()).toBe(
      24 * HOUR,
    );
    const runs = await node.db
      .select()
      .from(recordScheduleRuns)
      .where(eq(recordScheduleRuns.scheduleId, id));
    expect(runs).toHaveLength(1);
    expect(await audit('recordSchedule.ran', id)).toHaveLength(1);
  });

  it('makes up missed occurrences, oldest first', async () => {
    const ada = await node.user(['editor']);
    const { body } = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, template: { title: 'Missed' } })
      .expect(201);
    const { now } = await due(body.id, 3 * 24 * HOUR + HOUR);
    expect(await node.app.get(RecordScheduleRunnerJob).run(now)).toBe(4);
    expect(await notesNamed('Missed')).toHaveLength(4);
    expect((await state(body.id)).occurrences).toBe(4);
  });

  it('ends after COUNT occurrences', async () => {
    const ada = await node.user(['editor']);
    const { body } = await ada.agent
      .post('/v1/record-schedules')
      .send({
        ...daily,
        template: { title: 'Counted' },
        rrule: 'FREQ=DAILY;COUNT=2',
      })
      .expect(201);
    expect(body.maxOccurrences).toBe(2);
    const { now } = await due(body.id, 5 * 24 * HOUR);
    expect(await node.app.get(RecordScheduleRunnerJob).run(now)).toBe(2);
    expect(await state(body.id)).toMatchObject({
      status: 'ended',
      endReason: 'completed',
      nextRunAt: null,
      occurrences: 2,
    });
  });

  it('pauses without making up the pause, resumes from now, and ends for good', async () => {
    const ada = await node.user(['editor']);
    const { body } = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, template: { title: 'Paused' } })
      .expect(201);
    const id = body.id as string;
    const { now } = await due(id, 2 * 24 * HOUR);
    const paused = await ada.agent
      .post(`/v1/record-schedules/${id}/pause`)
      .expect(200);
    expect(paused.body).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(await node.app.get(RecordScheduleRunnerJob).run(now)).toBe(0);
    expect(await notesNamed('Paused')).toHaveLength(0);

    const resumed = await ada.agent
      .post(`/v1/record-schedules/${id}/resume`)
      .expect(200);
    expect(resumed.body.status).toBe('active');
    expect(new Date(resumed.body.nextRunAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(await notesNamed('Paused')).toHaveLength(0);

    const ended = await ada.agent
      .post(`/v1/record-schedules/${id}/end`)
      .expect(200);
    expect(ended.body).toMatchObject({ status: 'ended', endReason: 'ended' });
    await ada.agent.post(`/v1/record-schedules/${id}/resume`).expect(409);
    await ada.agent
      .patch(`/v1/record-schedules/${id}`)
      .send({ name: 'x' })
      .expect(409);
  });

  it('counts failures and skips the occurrence on the third, going on to the next', async () => {
    const ada = await node.user(['editor']);
    const { body } = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, template: { title: 'Failing' } })
      .expect(201);
    const id = body.id as string;
    const importer = node.app.get(DataTransferRegistry).importer('notes')!;
    const write = vi
      .spyOn(importer, 'write')
      .mockRejectedValue(new Error('boom'));
    const runner = node.app.get(RecordScheduleRunnerJob);
    const { now, nextRunAt } = await due(id, HOUR);

    expect(await runner.run(now)).toBe(0);
    expect(await state(id)).toMatchObject({
      failures: 1,
      lastStatus: 'failed',
      lastError: 'boom',
      occurrences: 0,
    });
    expect((await state(id)).nextRunAt).toEqual(nextRunAt);
    await runner.run(now);
    expect((await state(id)).failures).toBe(2);
    await runner.run(now);
    const skipped = await state(id);
    expect(skipped).toMatchObject({ failures: 0, occurrences: 1 });
    expect(skipped.nextRunAt!.getTime() - nextRunAt.getTime()).toBe(24 * HOUR);
    expect(write).toHaveBeenCalledTimes(3);
    expect(await audit('recordSchedule.skipped', id)).toHaveLength(1);
    expect(await notesNamed('Failing')).toHaveLength(0);

    // The importer works again: the next occurrence is made.
    write.mockRestore();
    expect(
      await runner.run(new Date(skipped.nextRunAt!.getTime() + 1000)),
    ).toBe(1);
    expect(await notesNamed('Failing')).toHaveLength(1);
  });

  it("checks the owner's access again: an owner who lost it, or is gone, ends the schedule", async () => {
    const ada = await node.user(['editor']);
    const { body } = await ada.agent
      .post('/v1/record-schedules')
      .send({ ...daily, template: { title: 'Revoked' } })
      .expect(201);
    const id = body.id as string;
    await node
      .admin()
      .patch(`/v1/access/users/${ada.id}`)
      .send({ roleIds: [] })
      .expect(204);
    const { now } = await due(id, HOUR);
    expect(await node.app.get(RecordScheduleRunnerJob).run(now)).toBe(0);
    expect(await state(id)).toMatchObject({
      status: 'ended',
      endReason: 'import_not_allowed',
    });
    expect((await audit('recordSchedule.ended', id))[0]!.details).toMatchObject(
      {
        reason: 'import_not_allowed',
      },
    );
    expect(await notesNamed('Revoked')).toHaveLength(0);

    const client = await node.client();
    const made = await node
      .admin()
      .patch(`/v1/access/clients/${client.id}`)
      .send({ active: false });
    expect(made.status).toBeLessThan(500);
  });

  it('moves occurrences into the working time of a business calendar', async () => {
    const ada = await node.user(['editor']);
    const calendar = await node
      .admin()
      .post('/v1/calendars')
      .send({
        name: 'Office',
        timezone: 'UTC',
        hours: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          start: '09:00',
          end: '17:00',
        })),
        exceptions: [],
      })
      .expect(201);
    // 2030-01-05 is a Saturday: 03:00 moves to Monday 09:00.
    const created = await ada.agent
      .post('/v1/record-schedules')
      .send({
        ...daily,
        timezone: 'UTC',
        time: '03:00',
        startDate: '2030-01-05',
        calendarId: calendar.body.id,
      })
      .expect(201);
    expect(created.body.nextRunAt).toBe('2030-01-07T09:00:00.000Z');
    // The calendar can't go while it is followed.
    await node.admin().delete(`/v1/calendars/${calendar.body.id}`).expect(409);
    await ada.agent
      .delete(`/v1/record-schedules/${created.body.id}`)
      .expect(204);
    await node.admin().delete(`/v1/calendars/${calendar.body.id}`).expect(204);
  });
});
