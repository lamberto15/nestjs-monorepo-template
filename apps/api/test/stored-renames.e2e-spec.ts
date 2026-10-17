import { and, eq, inArray, sql } from 'drizzle-orm';
import { applyStoredRenames } from '../src/core/database/stored-renames.js';
import { rolePermissions, roles } from '../src/iam/iam.tables.js';
import { settingOverrides } from '../src/platform/settings/settings.tables.js';
import { STORED_RENAMES } from '../src/stored-renames.js';
import { bootApp, type TestApp } from './support.js';

/**
 * Names stored in rows, rewritten by migrate (core/database/stored-renames.ts):
 * a database from before org units became teams keeps working. Run as the
 * owner, tenant by tenant, under the forced row-level security.
 */
describe('stored renames (e2e)', () => {
  let node: TestApp;

  beforeEach(async () => {
    node = await bootApp();
  });
  afterEach(() => node.close());

  it("rewrites every tenant's old names once, and a stale one denies until then", async () => {
    const other = await node.otherTenant();
    const lead = await node.user(['team-lead']);
    // The rows as a release before the rename left them (the test pool
    // reads and writes every tenant: the maintenance role).
    const leads = await node.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, 'team-lead'));
    expect(leads).toHaveLength(2);
    const leadIds = leads.map((role) => role.id);
    await node.db
      .update(rolePermissions)
      .set({
        conditions: sql`replace(${rolePermissions.conditions}::text, '"inMyTeams"', '"inMyUnits"')::jsonb`,
      })
      .where(inArray(rolePermissions.roleId, leadIds));
    await node.db
      .update(rolePermissions)
      .set({ action: 'manageOrgUnits' })
      .where(
        and(
          inArray(rolePermissions.roleId, leadIds),
          eq(rolePermissions.action, 'read'),
        ),
      );
    await node.db.insert(settingOverrides).values(
      [node.tenantId, other.id].map((tenantId) => ({
        tenantId,
        key: 'notes.publishDelay',
        scope: 'orgUnit' as never,
        scopeId: '',
        value: 1,
        updatedBy: 'user:test',
      })),
    );

    // A role naming a condition no declaration has grants nothing: an
    // empty list, not a failure of every request.
    await lead.agent.get('/v1/notes').expect(200);

    const lines: string[] = [];
    await applyStoredRenames(node.database.ownerUrl, STORED_RENAMES, (line) =>
      lines.push(line),
    );
    const stale = async () => ({
      conditions: (
        await node.db
          .select({ id: rolePermissions.id })
          .from(rolePermissions)
          .where(sql`${rolePermissions.conditions}::text like '%"inMyUnits"%'`)
      ).length,
      actions: (
        await node.db
          .select({ id: rolePermissions.id })
          .from(rolePermissions)
          .where(eq(rolePermissions.action, 'manageOrgUnits'))
      ).length,
      scopes: (
        await node.db
          .select({ id: settingOverrides.id })
          .from(settingOverrides)
          .where(eq(settingOverrides.scope, 'orgUnit' as never))
      ).length,
    });
    expect(await stale()).toEqual({ conditions: 0, actions: 0, scopes: 0 });
    expect(lines.join('\n')).toMatch(/inMyUnits → inMyTeams in \d+ rows/);
    expect(lines.join('\n')).toMatch(/orgUnit → team in 2 rows/);

    // Once: a second run finds nothing to change.
    const again: string[] = [];
    await applyStoredRenames(node.database.ownerUrl, STORED_RENAMES, (line) =>
      again.push(line),
    );
    expect(again).toEqual([]);
  });
});
