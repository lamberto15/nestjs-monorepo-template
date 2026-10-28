import { eq, inArray, like, sql } from 'drizzle-orm';
import {
  applyStoredRenames,
  assertNoRetiredNames,
} from '../src/core/database/stored-renames.js';
import { rolePermissions, roles } from '../src/iam/iam.tables.js';
import { settingOverrides } from '../src/platform/settings/settings.tables.js';
import { savedViews } from '../src/platform/views/views.tables.js';
import { RETIRED_NAMES, STORED_RENAMES } from '../src/stored-renames.js';
import { bootApp, type TestApp } from './support.js';

/**
 * The guard at migrate (core/database/stored-renames.ts): a database that
 * skipped the organizational-units release, and still holds a team-era
 * name, fails loudly instead of running on. Run as the owner, tenant by
 * tenant, under the forced row-level security.
 */
describe('retired stored names (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  it("rewrites a view's team:<id> scope before the guard reads it, as migrate does (#836)", async () => {
    const unit = (
      await node
        .admin()
        .post('/v1/access/organizational-units')
        .send({ type: 'team', name: 'Sales' })
        .expect(201)
    ).body.id as string;
    // A view shared with a team before the units rename: its visibility was
    // renamed by that release, its scope prefix was not.
    await node.db.insert(savedViews).values({
      tenantId: node.tenantId,
      subject: 'TestItem',
      name: 'Shared before',
      visibility: 'unit',
      owner: 'user:test',
      unitId: unit,
      scope: `team:${unit}`,
    });
    const lines: string[] = [];
    await applyStoredRenames(node.database.ownerUrl, STORED_RENAMES, (line) =>
      lines.push(line),
    );
    expect(lines.join('\n')).toMatch(
      /saved_views\.scope team: → unit: in 1 rows/,
    );
    expect(
      await node.db
        .select({ scope: savedViews.scope })
        .from(savedViews)
        .where(like(savedViews.scope, 'team:%')),
    ).toEqual([]);
    await expect(
      assertNoRetiredNames(node.database.ownerUrl, RETIRED_NAMES),
    ).resolves.toBeUndefined();
  });

  it('passes a clean database, and names every tenant and column holding a team-era name', async () => {
    const other = await node.otherTenant();
    await expect(
      assertNoRetiredNames(node.database.ownerUrl, RETIRED_NAMES),
    ).resolves.toBeUndefined();

    // The rows as a release with teams left them (the test pool reads and
    // writes every tenant: the maintenance role).
    const leads = await node.db
      .select({ id: roles.id, tenantId: roles.tenantId })
      .from(roles)
      .where(eq(roles.key, 'unit-lead'));
    const leadIds = leads.map((role) => role.id);
    expect(leadIds.length).toBeGreaterThan(1);
    await node.db
      .update(roles)
      .set({ key: 'team-lead' })
      .where(inArray(roles.id, leadIds));
    await node.db
      .update(rolePermissions)
      .set({
        conditions: sql`replace(${rolePermissions.conditions}::text, '"inUnitsILeadAndBelow"', '"inMyTeams"')::jsonb`,
      })
      .where(inArray(rolePermissions.roleId, leadIds));
    await node.db.insert(settingOverrides).values({
      tenantId: other.id,
      key: 'approvals.maxDelegationDays',
      scope: 'team' as never,
      scopeId: '',
      value: 1,
      updatedBy: 'user:test',
    });

    const message = await assertNoRetiredNames(
      node.database.ownerUrl,
      RETIRED_NAMES,
    ).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(message).toMatch(/organizational-units release/);
    expect(message).toMatch(/roles\.key holds "team-lead" in 1 rows/);
    expect(message).toContain(`(tenant ${node.tenantId})`);
    expect(message).toMatch(/role_permissions\.conditions holds "inMyTeams"/);
    expect(message).toContain(
      `setting_overrides.scope holds "team" in 1 rows (tenant ${other.id})`,
    );
  });
});
