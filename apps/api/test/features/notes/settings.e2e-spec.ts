import { randomUUID } from 'node:crypto';
import { rolloutBucket } from '../../../src/platform/settings/setting-resolution.js';
import { bootApp, type TestApp } from '../../support.js';
import { writeNote } from './notes-support.js';

describe('settings and feature flags (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(async () => {
    await node.close();
  });

  /** A role of these permissions (no conditions), by id. */
  async function role(...permissions: [string, string][]) {
    const created = await node
      .admin()
      .post('/v1/access/roles')
      .send({
        name: `role-${randomUUID().slice(0, 8)}`,
        permissions: permissions.map(([subject, action]) => ({
          subject,
          action,
          conditions: [],
        })),
      })
      .expect(201);
    return created.body.id as string;
  }
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);
  const settingOf = (body: { items: { key: string }[] }, key: string) =>
    body.items.find((item) => item.key === key);

  it('shows every setting with its default; managers set values for everyone or a team, audited', async () => {
    const manager = await node.user([await role(['Access', 'manageSettings'])]);
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);

    const list = await editor.agent.get('/v1/settings').expect(200);
    expect(list.body.items.map((i: { key: string }) => i.key)).toEqual([
      'notes.publishDelay',
      'notes.richText',
      'notes.publishApproval',
    ]);
    expect(settingOf(list.body, 'notes.publishDelay')).toMatchObject({
      label: 'Publication delay',
      value: '10s',
      source: 'default',
      default: '10s',
      scopes: ['tenant'],
      flag: false,
      public: true,
    });
    expect(settingOf(list.body, 'notes.richText')).toMatchObject({
      value: false,
      source: 'default',
      scopes: ['tenant', 'team', 'user'],
      flag: true,
    });

    // Only managers set shared values; what they send is checked.
    await editor.agent
      .put('/v1/settings/notes.publishDelay')
      .send({ value: '2m' })
      .expect(403);
    const bad = await manager.agent
      .put('/v1/settings/notes.publishDelay')
      .send({ value: 'soon' })
      .expect(400);
    expect(paths(bad.body)).toEqual(['value']);
    await manager.agent
      .put('/v1/settings/notes.nope')
      .send({ value: 1 })
      .expect(404);
    const scope = await manager.agent
      .put('/v1/settings/notes.publishDelay')
      .send({ scope: 'user', scopeId: `user:${editor.id}`, value: '1m' })
      .expect(400);
    expect(paths(scope.body)).toEqual(['scope']);
    const rollout = await manager.agent
      .put('/v1/settings/notes.publishDelay')
      .send({ value: '1m', rollout: 10 })
      .expect(400);
    expect(paths(rollout.body)).toEqual(['rollout']);

    // For everyone.
    const set = await manager.agent
      .put('/v1/settings/notes.publishDelay')
      .send({ value: '2m' })
      .expect(200);
    expect(set.body).toMatchObject({
      key: 'notes.publishDelay',
      scope: 'tenant',
      scopeId: '',
      value: '2m',
      rollout: null,
      updatedBy: `user:${manager.id}`,
    });
    expect(
      (await editor.agent.get('/v1/settings/notes.publishDelay').expect(200))
        .body,
    ).toMatchObject({ value: '2m', source: 'tenant' });

    // The workflow reads it: a note written now waits two minutes, not ten seconds.
    const note = (
      await writeNote(node, editor.agent, { title: 'Slow', body: '' }).expect(
        201,
      )
    ).body as { id: string };
    await node.worker.drain();
    node.clock.advance('10s');
    await node.worker.drain();
    expect(
      (await editor.agent.get(`/v1/notes/${note.id}`).expect(200)).body.status,
    ).toBe('draft');
    node.clock.advance('2m');
    await node.worker.drain();
    expect(
      (await editor.agent.get(`/v1/notes/${note.id}`).expect(200)).body.status,
    ).toBe('published');

    // For a team: its users, not the others.
    const team = (
      await node
        .admin()
        .post('/v1/access/teams')
        .send({ name: 'Team A' })
        .expect(201)
    ).body as { id: string };
    await node
      .admin()
      .patch(`/v1/access/users/${editor.id}`)
      .send({ teamIds: [team.id] })
      .expect(204);
    await manager.agent
      .put('/v1/settings/notes.richText')
      .send({ scope: 'team', scopeId: team.id, value: true })
      .expect(200);
    expect(
      (await editor.agent.get('/v1/settings/notes.richText').expect(200)).body,
    ).toMatchObject({ value: true, source: 'team' });
    expect(
      (await other.agent.get('/v1/settings/notes.richText').expect(200)).body,
    ).toMatchObject({ value: false, source: 'default' });
    await manager.agent
      .put('/v1/settings/notes.richText')
      .send({ scope: 'team', scopeId: randomUUID(), value: true })
      .expect(404);

    // The stored values, and back to the default.
    const overrides = await manager.agent
      .get('/v1/settings/notes.richText/overrides')
      .expect(200);
    expect(overrides.body.items).toHaveLength(1);
    expect(overrides.body.items[0]).toMatchObject({
      scope: 'team',
      scopeId: team.id,
      value: true,
    });
    await editor.agent.get('/v1/settings/notes.richText/overrides').expect(403);
    await manager.agent
      .delete(`/v1/settings/notes.richText?scope=team&scopeId=${team.id}`)
      .expect(204);
    expect(
      (await editor.agent.get('/v1/settings/notes.richText').expect(200)).body,
    ).toMatchObject({ value: false, source: 'default' });

    const audit = await node
      .admin()
      .get('/v1/access/audit?action=setting.updated')
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThanOrEqual(2);
    expect(
      audit.body.items.some(
        (entry: { targetId: string; details: { to: { value: unknown } } }) =>
          entry.targetId === 'notes.publishDelay' &&
          entry.details.to.value === '2m',
      ),
    ).toBe(true);
    expect(
      (
        await node
          .admin()
          .get('/v1/access/audit?action=setting.reset')
          .expect(200)
      ).body.items,
    ).toHaveLength(1);
  });

  it('rolls a flag out to a stable share of principals, which each may override for themselves', async () => {
    const manager = await node.user([await role(['Access', 'manageSettings'])]);
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);
    const mine = () =>
      editor.agent.get('/v1/settings/notes.richText').expect(200);

    const all = await manager.agent
      .put('/v1/settings/notes.richText')
      .send({ rollout: 100 })
      .expect(200);
    expect(all.body).toMatchObject({ value: null, rollout: 100 });
    expect((await mine()).body).toMatchObject({
      value: true,
      source: 'rollout',
    });
    await manager.agent
      .put('/v1/settings/notes.richText')
      .send({ rollout: 0 })
      .expect(200);
    expect((await mine()).body).toMatchObject({
      value: false,
      source: 'rollout',
    });
    await manager.agent
      .put('/v1/settings/notes.richText')
      .send({ rollout: 50 })
      .expect(200);
    const bucket = rolloutBucket(
      'notes.richText',
      node.tenantId,
      `user:${editor.id}`,
    );
    expect((await mine()).body).toMatchObject({
      value: bucket < 50,
      source: 'rollout',
    });
    // Twice the same answer.
    expect((await mine()).body.value).toBe(bucket < 50);

    // Their own choice beats the rollout; dropping it goes back.
    const own = await editor.agent
      .put('/v1/settings/notes.richText/mine')
      .send({ value: true })
      .expect(200);
    expect(own.body).toMatchObject({ value: true, source: 'user' });
    const invalid = await editor.agent
      .put('/v1/settings/notes.richText/mine')
      .send({ value: 'yes' })
      .expect(400);
    expect(paths(invalid.body)).toEqual(['value']);
    const notMine = await editor.agent
      .put('/v1/settings/notes.publishDelay/mine')
      .send({ value: '1m' })
      .expect(400);
    expect(paths(notMine.body)).toEqual(['key']);
    const dropped = await editor.agent
      .delete('/v1/settings/notes.richText/mine')
      .expect(200);
    expect(dropped.body).toMatchObject({
      value: bucket < 50,
      source: 'rollout',
    });

    // A manager sets one principal's value by key; the principal must exist.
    await manager.agent
      .put('/v1/settings/notes.richText')
      .send({ scope: 'user', scopeId: `user:${other.id}`, value: false })
      .expect(200);
    expect(
      (await other.agent.get('/v1/settings/notes.richText').expect(200)).body,
    ).toMatchObject({ value: false, source: 'user' });
    await manager.agent
      .put('/v1/settings/notes.richText')
      .send({ scope: 'user', scopeId: `user:${randomUUID()}`, value: false })
      .expect(404);

    // An API client reads its values too, and is a principal of its own in a rollout.
    const client = await node.client();
    const forClient = await node
      .http()
      .get('/v1/settings')
      .set('Authorization', client.auth)
      .expect(200);
    expect(settingOf(forClient.body, 'notes.richText')).toMatchObject({
      value:
        rolloutBucket('notes.richText', node.tenantId, `client:${client.id}`) <
        50,
      source: 'rollout',
    });
  });
});
