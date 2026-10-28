import { eq, inArray, like, sql } from 'drizzle-orm';
import { applyStoredRenames } from '../src/core/database/stored-renames.js';
import { AccessService } from '../src/iam/access/access.service.js';
import { rolePermissions, roles } from '../src/iam/iam.tables.js';
import { settingOverrides } from '../src/platform/settings/settings.tables.js';
import { savedViews } from '../src/platform/views/views.tables.js';
import { STORED_RENAMES } from '../src/stored-renames.js';
import { bootApp, type TestApp } from './support.js';

/**
 * Names stored in rows, rewritten by migrate (core/database/stored-renames.ts):
 * a database from before teams became organizational units keeps working,
 * and one from before org units became teams too (both renames, in order).
 * Run as the owner, tenant by tenant, under the forced row-level security.
 */
describe('stored renames (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  it("rewrites every tenant's old names once, and a stale one denies until then", async () => {
    const other = await node.otherTenant();
    const lead = await node.user(['unit-lead']);
    const unit = (
      await node
        .admin()
        .post('/v1/access/organizational-units')
        .send({ type: 'team', name: 'Sales' })
        .expect(201)
    ).body.id as string;
    await node
      .admin()
      .patch(`/v1/access/users/${lead.id}`)
      .send({ unitIds: [unit] })
      .expect(204);
    // The rows as a release with teams left them (the test pool reads and
    // writes every tenant: the maintenance role).
    const leads = await node.db
      .select({ id: roles.id, tenantId: roles.tenantId })
      .from(roles)
      .where(eq(roles.key, 'unit-lead'));
    expect(leads).toHaveLength(2);
    const leadIds = leads.map((role) => role.id);
    await node.db
      .update(roles)
      .set({ key: 'team-lead' })
      .where(inArray(roles.id, leadIds));
    // The team lead read what their teams and those below them own.
    await node.db
      .update(rolePermissions)
      .set({
        conditions: sql`replace(${rolePermissions.conditions}::text, '"inUnitsILeadAndBelow"', '"inMyTeams"')::jsonb`,
      })
      .where(inArray(rolePermissions.roleId, leadIds));
    // Older still, renamed twice in one run: org units → teams → units.
    await node.db.insert(rolePermissions).values(
      leads.map((role) => ({
        tenantId: role.tenantId,
        roleId: role.id,
        subject: 'Access',
        action: 'manageOrgUnits',
      })),
    );
    await node.db.insert(settingOverrides).values([
      ...[node.tenantId, other.id].map((tenantId) => ({
        tenantId,
        key: 'approvals.maxDelegationDays',
        scope: 'orgUnit' as never,
        scopeId: '',
        value: 1,
        updatedBy: 'user:test',
      })),
      {
        tenantId: node.tenantId,
        key: 'testItems.view',
        scope: 'team' as never,
        scopeId: unit,
        value: 'cards',
        updatedBy: 'user:test',
      },
    ]);
    // The checks take 'team' for this release: the renames run after them.
    await node.db.insert(savedViews).values({
      tenantId: node.tenantId,
      subject: 'TestItem',
      name: 'Shared before',
      visibility: 'team' as never,
      owner: 'user:test',
      unitId: unit,
      scope: `team:${unit}`,
    });

    // A role naming a condition no declaration has grants nothing: an
    // empty list, not a failure of every request.
    await lead.agent.get('/v1/test-items').expect(200);

    const lines: string[] = [];
    await applyStoredRenames(node.database.ownerUrl, STORED_RENAMES, (line) =>
      lines.push(line),
    );
    const stale = async () => ({
      conditions: (
        await node.db
          .select({ id: rolePermissions.id })
          .from(rolePermissions)
          .where(sql`${rolePermissions.conditions}::text like '%"inMyTeams"%'`)
      ).length,
      actions: (
        await node.db
          .select({ id: rolePermissions.id })
          .from(rolePermissions)
          .where(
            inArray(rolePermissions.action, ['manageOrgUnits', 'manageTeams']),
          )
      ).length,
      scopes: (
        await node.db
          .select({ id: settingOverrides.id })
          .from(settingOverrides)
          .where(
            inArray(settingOverrides.scope, ['orgUnit', 'team'] as never[]),
          )
      ).length,
      views: (
        await node.db
          .select({ id: savedViews.id })
          .from(savedViews)
          .where(eq(savedViews.visibility, 'team' as never))
      ).length,
      viewScopes: (
        await node.db
          .select({ id: savedViews.id })
          .from(savedViews)
          .where(like(savedViews.scope, 'team:%'))
      ).length,
      keys: (
        await node.db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.key, 'team-lead'))
      ).length,
    });
    expect(await stale()).toEqual({
      conditions: 0,
      actions: 0,
      scopes: 0,
      views: 0,
      viewScopes: 0,
      keys: 0,
    });
    const log = lines.join('\n');
    expect(log).toMatch(/inMyTeams → inMyUnitsAndBelow in \d+ rows/);
    expect(log).toMatch(/manageOrgUnits → manageTeams in 2 rows/);
    expect(log).toMatch(/manageTeams → manageOrganizationalUnits in 2 rows/);
    expect(log).toMatch(/orgUnit → team in 2 rows/);
    expect(log).toMatch(/setting_overrides\.scope team → unit in 3 rows/);
    expect(log).toMatch(/saved_views\.visibility team → unit in 1 rows/);
    expect(log).toMatch(/saved_views\.scope team: → unit: in 1 rows/);
    expect(log).toMatch(/roles\.key team-lead → unit-lead in 2 rows/);

    // The renamed rows work: the lead's role reads its units' and those
    // below (what `inMyTeams` granted), the unit's view is its members'.
    const [renamed] = await node.db
      .select({ key: roles.key })
      .from(roles)
      .where(eq(roles.id, leadIds[0]!));
    expect(renamed!.key).toBe('unit-lead');
    // As a deploy restarts the app: no ability cached from before.
    node.app.get(AccessService).invalidate();
    const writer = await node.user(['editor']);
    await node
      .admin()
      .patch(`/v1/access/users/${writer.id}`)
      .send({ unitIds: [unit] })
      .expect(204);
    await node
      .writeItem(writer.agent, { title: 'Ours', body: 'x' })
      .expect(201);
    expect(
      (await lead.agent.get('/v1/test-items').expect(200)).body.items,
    ).toMatchObject([{ title: 'Ours' }]);
    expect(
      (await lead.agent.get('/v1/views').expect(200)).body.items,
    ).toMatchObject([{ name: 'Shared before', visibility: 'unit' }]);

    // Once: a second run finds nothing to change.
    const again: string[] = [];
    await applyStoredRenames(node.database.ownerUrl, STORED_RENAMES, (line) =>
      again.push(line),
    );
    expect(again).toEqual([]);
  });
});
