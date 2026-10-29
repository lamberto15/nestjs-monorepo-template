import { randomUUID } from 'node:crypto';
import { OutboxRelay } from '@nestjs/outbox';
import { bootApp, type TestApp } from './support.js';

describe('automation rules (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** Runs what the committed writes queued: the rules' runs. */
  const run = () => node.app.get(OutboxRelay).runOnce();
  const item = async (title: string) =>
    (await node.writeItem(node.admin(), { title, body: 'Text' }).expect(201))
      .body as { id: string };
  const tag = async () =>
    (
      await node
        .admin()
        .post('/v1/tags')
        .send({
          subject: 'TestItem',
          name: `Urgent ${randomUUID().slice(0, 4)}`,
        })
        .expect(201)
    ).body as { id: string; name: string };

  it('simulates without effects, then runs the same actions once activated, once per change, never on its own writes', async () => {
    const urgent = await tag();
    const definition = {
      subject: 'TestItem',
      trigger: 'created',
      filters: { 'title.contains': 'urgent' },
      actions: [
        { type: 'addTag', tagId: urgent.id },
        { type: 'setField', field: 'body', value: 'Escalated' },
      ],
    };
    const matching = await item('An urgent thing');
    await item('A calm thing');

    // The simulation: the same evaluator, no write.
    const simulated = await node
      .admin()
      .post('/v1/automation-rules/simulate')
      .send({ ...definition, limit: 10 })
      .expect(200);
    expect(simulated.body).toMatchObject({
      subject: 'TestItem',
      limit: 10,
      matched: 1,
      truncated: false,
      triggerSimulated: true,
    });
    expect(simulated.body.matches).toEqual([
      {
        recordId: matching.id,
        title: 'An urgent thing',
        actions: [
          { type: 'addTag', allowed: true, reason: null, detail: urgent.name },
          {
            type: 'setField',
            allowed: true,
            reason: null,
            detail: 'body = "Escalated"',
          },
        ],
      },
    ]);
    const untouched = await node
      .admin()
      .get(`/v1/test-items/${matching.id}`)
      .expect(200);
    expect(untouched.body).toMatchObject({ body: 'Text', tags: [] });

    const created = await node
      .admin()
      .post('/v1/automation-rules')
      .send({ name: 'Tag urgent items', ...definition })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'draft', version: 1 });
    const id = created.body.id as string;
    // A draft runs nothing.
    await item('Urgent, before activation');
    await run();
    let runs = await node
      .admin()
      .get(`/v1/automation-rules/${id}/runs`)
      .expect(200);
    expect(runs.body.items).toEqual([]);

    const active = await node
      .admin()
      .post(`/v1/automation-rules/${id}/activate`)
      .expect(200);
    expect(active.body.status).toBe('active');
    expect(active.body.owner).toMatch(/^user:/);
    // A rule on its own field changes: the first rule's write must not start it.
    const loop = await node
      .admin()
      .post('/v1/automation-rules')
      .send({
        name: 'On body changes',
        subject: 'TestItem',
        trigger: 'updated',
        field: 'body',
        actions: [{ type: 'setField', field: 'body', value: 'Again' }],
      })
      .expect(201);
    await node
      .admin()
      .post(`/v1/automation-rules/${loop.body.id}/activate`)
      .expect(200);

    const target = await item('Very urgent');
    const calm = await item('Calm');
    await run();
    await run(); // anything the actions queued (nothing: no loop)

    const after = await node
      .admin()
      .get(`/v1/test-items/${target.id}`)
      .expect(200);
    expect(after.body.body).toBe('Escalated');
    expect(after.body.tags.map((t: { id: string }) => t.id)).toEqual([
      urgent.id,
    ]);
    const calmAfter = await node
      .admin()
      .get(`/v1/test-items/${calm.id}`)
      .expect(200);
    expect(calmAfter.body.body).toBe('Text');

    runs = await node
      .admin()
      .get(`/v1/automation-rules/${id}/runs`)
      .expect(200);
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0]).toMatchObject({
      recordId: target.id,
      ruleVersion: 1,
      status: 'succeeded',
      error: null,
    });
    // What the run did is what the simulation showed.
    expect(
      runs.body.items[0].actions.map((a: { type: string }) => a.type),
    ).toEqual(['addTag', 'setField']);
    const looped = await node
      .admin()
      .get(`/v1/automation-rules/${loop.body.id}/runs`)
      .expect(200);
    expect(looped.body.items).toEqual([]);

    // A change of what it does: a new version, a draft until activated again.
    const changed = await node
      .admin()
      .patch(`/v1/automation-rules/${id}`)
      .send({ filters: { 'title.contains': 'critical' } })
      .expect(200);
    expect(changed.body).toMatchObject({ status: 'draft', version: 2 });

    const actions = (
      await Promise.all(
        [
          'automation-rule.created',
          'automation-rule.activated',
          'automation-rule.updated',
        ].map((action) => node.auditEntries({ action })),
      )
    )
      .flat()
      .filter((entry) => entry.targetId === id)
      .map((entry) => entry.action)
      .sort((a, b) => a.localeCompare(b));
    expect(actions).toEqual([
      'automation-rule.activated',
      'automation-rule.created',
      'automation-rule.updated',
    ]);
  });

  it('keeps failed runs visible, disables a failing rule, and stops a disabled one', async () => {
    const created = await node
      .admin()
      .post('/v1/automation-rules')
      .send({
        name: 'Tell nobody',
        subject: 'TestItem',
        trigger: 'created',
        // A member who doesn't exist: nobody may be told.
        actions: [{ type: 'notify', userIds: [randomUUID()] }],
      })
      .expect(201);
    const id = created.body.id as string;
    await node.admin().post(`/v1/automation-rules/${id}/activate`).expect(200);

    for (let i = 0; i < 5; i++) {
      await item(`Item ${i}`);
      await run();
    }
    const rule = await node
      .admin()
      .get(`/v1/automation-rules/${id}`)
      .expect(200);
    expect(rule.body).toMatchObject({
      status: 'disabled',
      disabledReason: 'failing',
      lastStatus: 'failed',
      failures: 5,
    });
    const failed = await node
      .admin()
      .get(`/v1/automation-rules/${id}/runs?status=failed`)
      .expect(200);
    expect(failed.body.items).toHaveLength(5);
    expect(failed.body.items[0]).toMatchObject({
      error: 'notify: no_recipient',
      actions: [{ type: 'notify', allowed: false, reason: 'no_recipient' }],
    });
    const disabled = await node.auditEntries({
      action: 'automation-rule.disabled',
    });
    expect(disabled.find((e) => e.targetId === id)).toMatchObject({
      actor: 'system:automations',
      details: { reason: 'failing' },
    });

    // Disabled by hand: queued runs find it disabled and do nothing.
    const urgent = await tag();
    const other = await node
      .admin()
      .post('/v1/automation-rules')
      .send({
        name: 'Tag all',
        subject: 'TestItem',
        trigger: 'created',
        actions: [{ type: 'addTag', tagId: urgent.id }],
      })
      .expect(201);
    await node
      .admin()
      .post(`/v1/automation-rules/${other.body.id}/activate`)
      .expect(200);
    const queued = await item('Queued');
    await node
      .admin()
      .post(`/v1/automation-rules/${other.body.id}/disable`)
      .expect(200);
    await run();
    const shown = await node
      .admin()
      .get(`/v1/test-items/${queued.id}`)
      .expect(200);
    expect(shown.body.tags).toEqual([]);
  });

  it('refuses what it should: no permission, a bad definition, hidden conditions', async () => {
    const editor = await node.user(['editor']);
    await editor.agent.get('/v1/automation-rules').expect(403);
    await editor.agent
      .post('/v1/automation-rules/simulate')
      .send({
        subject: 'TestItem',
        trigger: 'created',
        actions: [{ type: 'setField', field: 'title', value: 'x' }],
      })
      .expect(403);

    const bad = (body: Record<string, unknown>) =>
      node
        .admin()
        .post('/v1/automation-rules')
        .send({
          name: 'Bad',
          subject: 'TestItem',
          trigger: 'created',
          actions: [{ type: 'setField', field: 'title', value: 'x' }],
          ...body,
        })
        .expect(400);
    const paths = async (body: Record<string, unknown>) =>
      ((await bad(body)).body.errors as { path: string }[]).map((e) => e.path);
    expect(await paths({ subject: 'Nope' })).toEqual(['subject']);
    expect(await paths({ field: 'title' })).toEqual(['field']);
    expect(await paths({ filters: { limit: '5' } })).toEqual(['filters.limit']);
    expect(await paths({ filters: { 'nope.contains': 'x' } })).toEqual([
      expect.stringMatching(/^filters/),
    ]);
    expect(
      await paths({
        actions: [{ type: 'setField', field: 'parentId', value: 'x' }],
      }),
    ).toEqual(['actions.0.field']);
    expect(
      await paths({ actions: [{ type: 'addTag', tagId: randomUUID() }] }),
    ).toEqual(['actions.0.tagId']);

    const subjects = await node
      .admin()
      .get('/v1/automation-rules/subjects')
      .expect(200);
    expect(subjects.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'TestItem',
          tags: true,
          settable: expect.arrayContaining(['title', 'body']),
        }),
      ]),
    );
  });
});
