import { bootApp, type TestApp } from './support.js';

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

const office = {
  name: 'Support desk',
  timezone: 'America/New_York',
  hours: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start: '09:00',
    end: '17:00',
  })),
  exceptions: [{ date: '2026-12-25', name: 'Christmas Day' }],
};

describe('business calendars (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  const audit = async (action: string, targetId: string) =>
    (
      await node
        .admin()
        .get(`/v1/access/audit?action=${action}&targetId=${targetId}`)
        .expect(200)
    ).body.items as { details: Record<string, unknown> }[];

  it('is managed by those with Access.manageCalendars, read by anyone, audited', async () => {
    const editor = await node.user(['editor']);
    await editor.agent.post('/v1/calendars').send(office).expect(403);

    const created = await node.admin().post('/v1/calendars').send(office).expect(201);
    expect(created.body).toMatchObject({ ...office, version: 1 });
    const id = created.body.id as string;

    expect(
      (await editor.agent.get('/v1/calendars').expect(200)).body.items,
    ).toHaveLength(1);
    await editor.agent.get(`/v1/calendars/${id}`).expect(200);
    await editor.agent.delete(`/v1/calendars/${id}`).expect(403);
    await node.admin().post('/v1/calendars').send(office).expect(409);
    expect(await audit('businessCalendar.created', id)).toHaveLength(1);
  });

  it('refuses a bad zone, overlapping spans and a date twice', async () => {
    const response = await node
      .admin()
      .post('/v1/calendars')
      .send({
        ...office,
        name: 'Bad',
        timezone: 'Mars/Base',
        exceptions: [
          { date: '2026-12-25', name: 'A' },
          { date: '2026-12-25', name: 'B' },
        ],
      })
      .expect(400);
    expect(paths(response.body)).toEqual(
      expect.arrayContaining(['timezone', 'exceptions.1.date']),
    );
    const overlap = await node
      .admin()
      .post('/v1/calendars')
      .send({
        ...office,
        name: 'Overlap',
        hours: [
          { weekday: 1, start: '09:00', end: '13:00' },
          { weekday: 1, start: '12:00', end: '17:00' },
        ],
      })
      .expect(400);
    expect(paths(overlap.body)).toEqual(['hours']);
  });

  it('raises the version when the hours, zone or exceptions change, not on a rename; audits it', async () => {
    const { body } = await node.admin().post('/v1/calendars').send(office).expect(201);
    const id = body.id as string;
    const renamed = await node
      .admin()
      .patch(`/v1/calendars/${id}`)
      .send({ name: 'Help desk' })
      .expect(200);
    expect(renamed.body.version).toBe(1);
    const same = await node
      .admin()
      .patch(`/v1/calendars/${id}`)
      .send({ hours: office.hours })
      .expect(200);
    expect(same.body.version).toBe(1);
    const changed = await node
      .admin()
      .patch(`/v1/calendars/${id}`)
      .send({ exceptions: [] })
      .expect(200);
    expect(changed.body.version).toBe(2);
    expect(
      (await audit('businessCalendar.updated', id)).map((e) => e.details),
    ).toHaveLength(3);
  });

  it('computes a deadline in working time across a daylight-saving change, with the version', async () => {
    const { body } = await node.admin().post('/v1/calendars').send(office).expect(201);
    const id = body.id as string;
    const editor = await node.user(['editor']);
    // Fri 2026-03-06 16:00 EST + 2 h: Monday 2026-03-09 10:00 is EDT.
    const first = await editor.agent
      .post(`/v1/calendars/${id}/deadline`)
      .send({ from: '2026-03-06T21:00:00Z', minutes: 120 })
      .expect(200);
    expect(first.body).toEqual({
      due: '2026-03-09T14:00:00.000Z',
      calendarVersion: 1,
    });
    // Christmas Day is closed: Thursday 24th 16:00 EST + 2 h -> Monday 28th 10:00.
    const holiday = await editor.agent
      .post(`/v1/calendars/${id}/deadline`)
      .send({ from: '2026-12-24T21:00:00Z', minutes: 120 })
      .expect(200);
    expect(holiday.body.due).toBe('2026-12-28T15:00:00.000Z');
    // Existing deadlines are not touched by a change; asking again gives the new version.
    await node
      .admin()
      .patch(`/v1/calendars/${id}`)
      .send({ exceptions: [] })
      .expect(200);
    const after = await editor.agent
      .post(`/v1/calendars/${id}/deadline`)
      .send({ from: '2026-12-24T21:00:00Z', minutes: 120 })
      .expect(200);
    expect(after.body).toEqual({
      due: '2026-12-25T15:00:00.000Z',
      calendarVersion: 2,
    });
  });

  it('answers 400 for a calendar with no working time, and is the tenant\'s own', async () => {
    const { body } = await node
      .admin()
      .post('/v1/calendars')
      .send({ ...office, hours: [], exceptions: [] })
      .expect(201);
    const response = await node
      .admin()
      .post(`/v1/calendars/${body.id}/deadline`)
      .send({ from: '2026-03-06T21:00:00Z', minutes: 5 })
      .expect(400);
    expect(response.body.code).toBe('calendar_has_no_working_time');

    const other = await node.otherTenant();
    await other.admin.get(`/v1/calendars/${body.id}`).expect(404);
    expect(
      (await other.admin.get('/v1/calendars').expect(200)).body.items,
    ).toEqual([]);
  });
});
