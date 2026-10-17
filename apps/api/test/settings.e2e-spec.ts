import { randomUUID } from 'node:crypto';
import { bootApp, type TestApp } from './support.js';

/**
 * The platform's settings, on a key the platform itself declares
 * (`approvals.maxDelegationDays`: a number, tenant scope, shown to managers
 * only). Flags, team and user scopes and rollouts need a feature's declared
 * key: the feature's own spec (test/features/<feature>/).
 */
const KEY = 'approvals.maxDelegationDays';

describe('settings (e2e)', () => {
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

  it('shows a setting with its default to managers only; they set the value for everyone, audited', async () => {
    const manager = await node.user([await role(['Access', 'manageSettings'])]);
    const editor = await node.user(['editor']);

    // A setting that isn't public is for those who manage settings.
    const shown = await editor.agent.get('/v1/settings').expect(200);
    expect(settingOf(shown.body, KEY)).toBeUndefined();
    const list = await manager.agent.get('/v1/settings').expect(200);
    expect(settingOf(list.body, KEY)).toMatchObject({
      value: 90,
      source: 'default',
      default: 90,
      scopes: ['tenant'],
      flag: false,
      public: false,
    });

    // Only managers set shared values; what they send is checked.
    await editor.agent
      .put(`/v1/settings/${KEY}`)
      .send({ value: 30 })
      .expect(403);
    const bad = await manager.agent
      .put(`/v1/settings/${KEY}`)
      .send({ value: 'soon' })
      .expect(400);
    expect(paths(bad.body)).toEqual(['value']);
    await manager.agent
      .put('/v1/settings/approvals.nope')
      .send({ value: 1 })
      .expect(404);
    const scope = await manager.agent
      .put(`/v1/settings/${KEY}`)
      .send({ scope: 'user', scopeId: `user:${editor.id}`, value: 30 })
      .expect(400);
    expect(paths(scope.body)).toEqual(['scope']);
    const rollout = await manager.agent
      .put(`/v1/settings/${KEY}`)
      .send({ value: 30, rollout: 10 })
      .expect(400);
    expect(paths(rollout.body)).toEqual(['rollout']);
    // Not one a principal may set for themselves.
    const notMine = await editor.agent
      .put(`/v1/settings/${KEY}/mine`)
      .send({ value: 30 })
      .expect(400);
    expect(paths(notMine.body)).toEqual(['key']);

    // For everyone.
    const set = await manager.agent
      .put(`/v1/settings/${KEY}`)
      .send({ value: 30 })
      .expect(200);
    expect(set.body).toMatchObject({
      key: KEY,
      scope: 'tenant',
      scopeId: '',
      value: 30,
      rollout: null,
      updatedBy: `user:${manager.id}`,
    });
    expect(
      (await manager.agent.get(`/v1/settings/${KEY}`).expect(200)).body,
    ).toMatchObject({ value: 30, source: 'tenant' });

    // The stored values, and back to the default.
    const overrides = await manager.agent
      .get(`/v1/settings/${KEY}/overrides`)
      .expect(200);
    expect(overrides.body.items).toHaveLength(1);
    expect(overrides.body.items[0]).toMatchObject({
      scope: 'tenant',
      value: 30,
    });
    await editor.agent.get(`/v1/settings/${KEY}/overrides`).expect(403);
    await manager.agent.delete(`/v1/settings/${KEY}`).expect(204);
    expect(
      (await manager.agent.get(`/v1/settings/${KEY}`).expect(200)).body,
    ).toMatchObject({ value: 90, source: 'default' });

    const audit = await node
      .admin()
      .get('/v1/access/audit?action=setting.updated')
      .expect(200);
    expect(
      audit.body.items.some(
        (entry: { targetId: string; details: { to: { value: unknown } } }) =>
          entry.targetId === KEY && entry.details.to.value === 30,
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
});
