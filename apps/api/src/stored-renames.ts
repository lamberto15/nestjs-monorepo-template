import type {
  RetiredName,
  StoredRename,
} from './core/database/stored-renames.js';
import { rolePermissions, roles } from './iam/iam.tables.js';
import {
  approvalPolicies,
  approvalRequests,
} from './platform/approvals/approvals.tables.js';
import { settingOverrides } from './platform/settings/settings.tables.js';
import { savedViews } from './platform/views/views.tables.js';

/**
 * Names the code renamed that rows store, rewritten by every migrate
 * (core/database/stored-renames.ts) after the migrations, in this order
 * (a name renamed twice goes through both). Keep an entry while a database
 * from before it may still be migrated; the release notes say which
 * release a project must pass through (docs/releases.md). Empty since the
 * team-era renames (org units → teams → organizational units) were removed
 * (#602); the next rename goes here.
 */
export const STORED_RENAMES: readonly StoredRename[] = [];

/**
 * Team-era names (org units → teams → organizational units, #595) that no
 * code reads and no rename rewrites any more. Migrate fails when a row
 * still holds one: the database skipped the organizational-units release.
 */
export const RETIRED_NAMES: readonly RetiredName[] = [
  { column: rolePermissions.action, name: 'manageTeams' },
  { column: rolePermissions.action, name: 'manageOrgUnits' },
  { column: rolePermissions.conditions, name: 'inMyTeams', json: true },
  { column: settingOverrides.scope, name: 'team' },
  { column: settingOverrides.scope, name: 'orgUnit' },
  { column: savedViews.visibility, name: 'team' },
  { column: savedViews.scope, name: 'team:', prefix: true },
  { column: approvalPolicies.definition, name: 'teamRole', json: true },
  { column: approvalPolicies.definition, name: 'orgUnitRole', json: true },
  { column: approvalPolicies.definition, name: 'team-lead', json: true },
  { column: approvalRequests.policy, name: 'teamRole', json: true },
  { column: approvalRequests.policy, name: 'orgUnitRole', json: true },
  { column: approvalRequests.policy, name: 'team-lead', json: true },
  { column: roles.key, name: 'team-lead' },
];
