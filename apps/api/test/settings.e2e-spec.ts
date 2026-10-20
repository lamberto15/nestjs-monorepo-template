import { randomUUID } from 'node:crypto';
import { rolloutBucket } from '../src/platform/settings/setting-resolution.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The platform's settings: on a key the platform itself declares
 * (`approvals.maxDelegationDays`: a number, tenant scope, shown to managers
 * only), and on the test-only feature's keys (test/fixtures/test-items/
 * test-item-settings.ts), declared as a feature declares them: a flag with
 * every scope (team, user, rollouts) and a value with team and user scopes.
 */
const KEY = 'approvals.maxDelegationDays';
const FLAG = 'testItems.richPreview';
const VIEW = 'testItems.view';

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

  /**
   * The test-only feature's own keys of a listing, in their declared order
   * (not those its record declares: record-approvals.e2e-spec.ts).
   */
  const RECORD_DECLARED = [
    'testItems.archiveAfterDays',
    'testItems.autoArchive',
    'testItems.sortBy',
    'testItems.archiveApproval',
    'testItems.markReviewedApproval',
  ];
  const testItemKeys = (body: { items: { key: string }[] }) =>
    body.items
      .map((i) => i.key)
      .filter(
        (key) => key.startsWith('testItems.') && !RECORD_DECLARED.includes(key),
      );

  it('shows a feature’s settings with their defaults; managers set values for everyone or a team, audited', async () => {
    const manager = await node.user([await role(['Access', 'manageSettings'])]);
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);

    // The public ones to everyone; the page limit only to managers.
    const list = await editor.agent.get('/v1/settings').expect(200);
    expect(testItemKeys(list.body)).toEqual([
      'testItems.richPreview',
      VIEW,
      'testItems.publishApproval',
    ]);
    expect(
      testItemKeys((await manager.agent.get('/v1/settings')).body),
    ).toEqual([
      'testItems.richPreview',
      VIEW,
      'testItems.pageLimit',
      'testItems.publishApproval',
    ]);
    expect(settingOf(list.body, VIEW)).toMatchObject({
      label: 'List view',
      value: 'table',
      source: 'default',
      default: 'table',
      scopes: ['tenant', 'team', 'user'],
      flag: false,
      public: true,
    });
    expect(settingOf(list.body, FLAG)).toMatchObject({
      value: false,
      source: 'default',
      scopes: ['tenant', 'team', 'user'],
      flag: true,
    });
    expect(settingOf(list.body, 'testItems.publishApproval')).toMatchObject({
      scopes: ['tenant', 'team'],
      flag: true,
    });

    // Only managers set shared values; what they send is checked.
    await editor.agent
      .put(`/v1/settings/${VIEW}`)
      .send({ value: 'cards' })
      .expect(403);
    const bad = await manager.agent
      .put(`/v1/settings/${VIEW}`)
      .send({ value: 'soon' })
      .expect(400);
    expect(paths(bad.body)).toEqual(['value']);
    await manager.agent
      .put('/v1/settings/testItems.nope')
      .send({ value: 1 })
      .expect(404);
    const rollout = await manager.agent
      .put(`/v1/settings/${VIEW}`)
      .send({ value: 'cards', rollout: 10 })
      .expect(400);
    expect(paths(rollout.body)).toEqual(['rollout']);

    // For everyone.
    const set = await manager.agent
      .put(`/v1/settings/${VIEW}`)
      .send({ value: 'cards' })
      .expect(200);
    expect(set.body).toMatchObject({
      key: VIEW,
      scope: 'tenant',
      scopeId: '',
      value: 'cards',
      rollout: null,
      updatedBy: `user:${manager.id}`,
    });
    expect(
      (await editor.agent.get(`/v1/settings/${VIEW}`).expect(200)).body,
    ).toMatchObject({ value: 'cards', source: 'tenant' });

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
      .put(`/v1/settings/${FLAG}`)
      .send({ scope: 'team', scopeId: team.id, value: true })
      .expect(200);
    expect(
      (await editor.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
    ).toMatchObject({ value: true, source: 'team' });
    expect(
      (await other.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
    ).toMatchObject({ value: false, source: 'default' });
    await manager.agent
      .put(`/v1/settings/${FLAG}`)
      .send({ scope: 'team', scopeId: randomUUID(), value: true })
      .expect(404);
    // A team's value beats the tenant's.
    await manager.agent
      .put(`/v1/settings/${VIEW}`)
      .send({ scope: 'team', scopeId: team.id, value: 'table' })
      .expect(200);
    expect(
      (await editor.agent.get(`/v1/settings/${VIEW}`).expect(200)).body,
    ).toMatchObject({ value: 'table', source: 'team' });
    expect(
      (await other.agent.get(`/v1/settings/${VIEW}`).expect(200)).body,
    ).toMatchObject({ value: 'cards', source: 'tenant' });
    await manager.agent
      .delete(`/v1/settings/${VIEW}?scope=team&scopeId=${team.id}`)
      .expect(204);

    // The stored values, and back to the default.
    const overrides = await manager.agent
      .get(`/v1/settings/${FLAG}/overrides`)
      .expect(200);
    expect(overrides.body.items).toHaveLength(1);
    expect(overrides.body.items[0]).toMatchObject({
      scope: 'team',
      scopeId: team.id,
      value: true,
    });
    await editor.agent.get(`/v1/settings/${FLAG}/overrides`).expect(403);
    await manager.agent
      .delete(`/v1/settings/${FLAG}?scope=team&scopeId=${team.id}`)
      .expect(204);
    expect(
      (await editor.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
    ).toMatchObject({ value: false, source: 'default' });

    const audit = await node
      .admin()
      .get('/v1/access/audit?action=setting.updated')
      .expect(200);
    expect(
      audit.body.items.some(
        (entry: { targetId: string; details: { to: { value: unknown } } }) =>
          entry.targetId === VIEW && entry.details.to.value === 'cards',
      ),
    ).toBe(true);
    expect(
      (
        await node
          .admin()
          .get('/v1/access/audit?action=setting.reset')
          .expect(200)
      ).body.items,
    ).toHaveLength(2);
  });

  it('rolls a flag out to a stable share of principals, which each may override for themselves', async () => {
    const manager = await node.user([await role(['Access', 'manageSettings'])]);
    const editor = await node.user(['editor']);
    const other = await node.user(['editor']);
    const mine = () => editor.agent.get(`/v1/settings/${FLAG}`).expect(200);

    const all = await manager.agent
      .put(`/v1/settings/${FLAG}`)
      .send({ rollout: 100 })
      .expect(200);
    expect(all.body).toMatchObject({ value: null, rollout: 100 });
    expect((await mine()).body).toMatchObject({
      value: true,
      source: 'rollout',
    });
    await manager.agent
      .put(`/v1/settings/${FLAG}`)
      .send({ rollout: 0 })
      .expect(200);
    expect((await mine()).body).toMatchObject({
      value: false,
      source: 'rollout',
    });
    await manager.agent
      .put(`/v1/settings/${FLAG}`)
      .send({ rollout: 50 })
      .expect(200);
    const bucket = rolloutBucket(FLAG, node.tenantId, `user:${editor.id}`);
    expect((await mine()).body).toMatchObject({
      value: bucket < 50,
      source: 'rollout',
    });
    // Twice the same answer.
    expect((await mine()).body.value).toBe(bucket < 50);

    // Their own choice beats the rollout; dropping it goes back.
    const own = await editor.agent
      .put(`/v1/settings/${FLAG}/mine`)
      .send({ value: true })
      .expect(200);
    expect(own.body).toMatchObject({ value: true, source: 'user' });
    const invalid = await editor.agent
      .put(`/v1/settings/${FLAG}/mine`)
      .send({ value: 'yes' })
      .expect(400);
    expect(paths(invalid.body)).toEqual(['value']);
    // A value of the user scope is a preference too.
    const view = await editor.agent
      .put(`/v1/settings/${VIEW}/mine`)
      .send({ value: 'cards' })
      .expect(200);
    expect(view.body).toMatchObject({ value: 'cards', source: 'user' });
    // Not one of the tenant scope only (the page limit), nor one an approval hangs on.
    const notMine = await editor.agent
      .put('/v1/settings/testItems.pageLimit/mine')
      .send({ value: 10 })
      .expect(400);
    expect(paths(notMine.body)).toEqual(['key']);
    const approval = await editor.agent
      .put('/v1/settings/testItems.publishApproval/mine')
      .send({ value: false })
      .expect(400);
    expect(paths(approval.body)).toEqual(['key']);
    const dropped = await editor.agent
      .delete(`/v1/settings/${FLAG}/mine`)
      .expect(200);
    expect(dropped.body).toMatchObject({
      value: bucket < 50,
      source: 'rollout',
    });

    // A manager sets one principal's value by key; the principal must exist.
    await manager.agent
      .put(`/v1/settings/${FLAG}`)
      .send({ scope: 'user', scopeId: `user:${other.id}`, value: false })
      .expect(200);
    expect(
      (await other.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
    ).toMatchObject({ value: false, source: 'user' });
    await manager.agent
      .put(`/v1/settings/${FLAG}`)
      .send({ scope: 'user', scopeId: `user:${randomUUID()}`, value: false })
      .expect(404);

    // An API client reads its values too, and is a principal of its own in a rollout.
    const client = await node.client();
    const forClient = await node
      .http()
      .get('/v1/settings')
      .set('Authorization', client.auth)
      .expect(200);
    expect(settingOf(forClient.body, FLAG)).toMatchObject({
      value: rolloutBucket(FLAG, node.tenantId, `client:${client.id}`) < 50,
      source: 'rollout',
    });
  });

  it('describes each value (type, options, bounds, JSON Schema) and whether the caller may set it', async () => {
    const manager = await node.user([await role(['Access', 'manageSettings'])]);
    const editor = await node.user(['editor']);

    const managed = await manager.agent.get('/v1/settings').expect(200);
    // Derived from each declaration's Zod schema (test-item-settings.ts, approval-settings.ts).
    expect(settingOf(managed.body, 'testItems.pageLimit')).toMatchObject({
      type: 'number',
      min: 1,
      max: 100,
      integer: true,
      schema: { type: 'integer', minimum: 1, maximum: 100 },
      canEdit: true,
      canSetMine: false,
    });
    expect(settingOf(managed.body, VIEW)).toMatchObject({
      type: 'enum',
      options: ['table', 'cards'],
      schema: { type: 'string', enum: ['table', 'cards'] },
      canEdit: true,
      canSetMine: true,
    });
    expect(settingOf(managed.body, FLAG)).toMatchObject({
      type: 'boolean',
      schema: { type: 'boolean' },
      canEdit: true,
    });
    expect(settingOf(managed.body, FLAG)).not.toHaveProperty('options');
    // One setting answers the same.
    const one = await manager.agent.get(`/v1/settings/${VIEW}`).expect(200);
    expect(one.body).toMatchObject({
      type: 'enum',
      options: ['table', 'cards'],
      canEdit: true,
    });

    // A plain user: the values described too, set only for themselves (user-scoped ones).
    const plain = await editor.agent.get('/v1/settings').expect(200);
    for (const item of plain.body.items as { canEdit: boolean }[]) {
      expect(item.canEdit).toBe(false);
    }
    expect(settingOf(plain.body, VIEW)).toMatchObject({
      type: 'enum',
      canEdit: false,
      canSetMine: true,
    });
    expect(
      (await editor.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
    ).toMatchObject({ type: 'boolean', canEdit: false, canSetMine: true });
    // What canEdit says is what the routes do.
    await editor.agent
      .put(`/v1/settings/${VIEW}`)
      .send({ value: 'cards' })
      .expect(403);
    await editor.agent
      .put(`/v1/settings/${VIEW}/mine`)
      .send({ value: 'cards' })
      .expect(200);

    // The administrator holds everything.
    const admin = await node.admin().get(`/v1/settings/${KEY}`).expect(200);
    expect(admin.body).toMatchObject({ type: 'number', canEdit: true });

    // DELETE answers 204 with no body (the typed client's unwrap(): undefined).
    await manager.agent
      .put(`/v1/settings/${VIEW}`)
      .send({ value: 'cards' })
      .expect(200);
    const removed = await manager.agent
      .delete(`/v1/settings/${VIEW}`)
      .expect(204);
    expect(removed.text).toBe('');
    expect(removed.headers['content-type']).toBeUndefined();
  });

  describe('platform values (operators, every tenant)', () => {
    it('sets a default for every tenant that set nothing, below their own values', async () => {
      const other = await node.otherTenant();
      const member = await other.user(['editor']);

      // Another tenant's administrator manages settings, but isn't an operator.
      await other.admin
        .put(`/v1/settings/${FLAG}/platform`)
        .send({ value: true })
        .expect(403);
      expect(
        (await other.admin.get(`/v1/settings/${FLAG}`).expect(200)).body,
      ).toMatchObject({
        platform: null,
        canEdit: true,
        canEditPlatform: false,
      });

      // Checked like any value.
      const bad = await node
        .admin()
        .put(`/v1/settings/${FLAG}/platform`)
        .send({ value: 'yes' })
        .expect(400);
      expect(paths(bad.body)).toEqual(['value']);
      await node
        .admin()
        .put('/v1/settings/testItems.nope/platform')
        .send({ value: true })
        .expect(404);

      const set = await node
        .admin()
        .put(`/v1/settings/${FLAG}/platform`)
        .send({ value: true })
        .expect(200);
      expect(set.body).toMatchObject({
        key: FLAG,
        value: true,
        enforced: false,
      });

      // Every tenant gets it, the operators' own too.
      for (const agent of [member.agent, node.admin()]) {
        expect(
          (await agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
        ).toMatchObject({
          value: true,
          source: 'platform',
          platform: { value: true, enforced: false },
        });
      }
      expect(
        (await node.admin().get(`/v1/settings/${FLAG}`).expect(200)).body
          .canEditPlatform,
      ).toBe(true);

      // A tenant's own value beats it.
      await other.admin
        .put(`/v1/settings/${FLAG}`)
        .send({ value: false })
        .expect(200);
      expect(
        (await member.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
      ).toMatchObject({ value: false, source: 'tenant' });

      // Removed: each tenant's own, or the default, again. Audited.
      await node.admin().delete(`/v1/settings/${FLAG}/platform`).expect(204);
      expect(
        (await node.admin().get(`/v1/settings/${FLAG}`).expect(200)).body,
      ).toMatchObject({ value: false, source: 'default', platform: null });
      const audit = await node
        .admin()
        .get('/v1/access/audit?action=setting.reset')
        .expect(200);
      expect(
        audit.body.items.some(
          (entry: { targetId: string; details: { scope: string } }) =>
            entry.targetId === FLAG && entry.details.scope === 'platform',
        ),
      ).toBe(true);
    });

    it('rolls a flag out in every tenant at once; a rollout is for flags and is never enforced', async () => {
      const other = await node.otherTenant();
      const member = await other.user(['editor']);

      const notFlag = await node
        .admin()
        .put(`/v1/settings/${VIEW}/platform`)
        .send({ rollout: 50 })
        .expect(400);
      expect(paths(notFlag.body)).toEqual(['rollout']);
      const enforced = await node
        .admin()
        .put(`/v1/settings/${FLAG}/platform`)
        .send({ rollout: 50, enforced: true })
        .expect(400);
      expect(paths(enforced.body)).toEqual(['enforced']);

      const set = await node
        .admin()
        .put(`/v1/settings/${FLAG}/platform`)
        .send({ rollout: 100 })
        .expect(200);
      expect(set.body).toMatchObject({ value: null, rollout: 100 });
      expect(
        (await member.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
      ).toMatchObject({
        value: true,
        source: 'platform',
        platform: { value: null, enforced: false, rollout: 100 },
      });
      await member.agent.get('/v1/test-items/rich-preview').expect(200);

      // A tenant's own rollout comes first.
      await other.admin
        .put(`/v1/settings/${FLAG}`)
        .send({ rollout: 0 })
        .expect(200);
      expect(
        (await member.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
      ).toMatchObject({ value: false, source: 'rollout' });
    });

    it('beats every value when enforced (a kill switch), and gates a flagged route', async () => {
      const other = await node.otherTenant();
      const member = await other.user(['editor']);

      // Off by default: the flagged route doesn't exist.
      await member.agent.get('/v1/test-items/rich-preview').expect(404);
      await member.agent
        .put(`/v1/settings/${FLAG}/mine`)
        .send({ value: true })
        .expect(200);
      expect(
        (await member.agent.get('/v1/test-items/rich-preview').expect(200))
          .body,
      ).toEqual({ richPreview: true });

      // The kill switch: off for everyone, whatever they set.
      await node
        .admin()
        .put(`/v1/settings/${FLAG}/platform`)
        .send({ value: false, enforced: true })
        .expect(200);
      expect(
        (await member.agent.get(`/v1/settings/${FLAG}`).expect(200)).body,
      ).toMatchObject({ value: false, source: 'platform' });
      await member.agent.get('/v1/test-items/rich-preview').expect(404);

      // Released: the member's own value holds again.
      await node.admin().delete(`/v1/settings/${FLAG}/platform`).expect(204);
      await member.agent.get('/v1/test-items/rich-preview').expect(200);
    });
  });
});
